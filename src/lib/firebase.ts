import { initializeApp, getApps, getApp } from 'firebase/app';
import { getDatabase, ref, onValue, get, set, remove } from 'firebase/database';
import { getDevices, saveDevice, Device, HealthReading, evaluateVitalsStatus } from './storage';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Check if credentials are valid
export const isFirebaseConfigured = (): boolean => {
  const keys = Object.values(firebaseConfig);
  return (
    keys.every(val => !!val) &&
    !firebaseConfig.apiKey?.includes('your-api-key') &&
    !firebaseConfig.databaseURL?.includes('your-project-id')
  );
};

// Initialize Firebase App
const app = 
  isFirebaseConfigured() 
    ? (getApps().length === 0 ? initializeApp(firebaseConfig) : getApp())
    : null;

// Initialize Realtime Database
export const database = app ? getDatabase(app) : null;

// Helper to determine seconds elapsed from HH:MM:SS time string to current client time (supporting UTC/Local and midnight wrapping)
export function getSecondsSinceLastUpdate(lastUpdatedStr: string): number {
  if (!lastUpdatedStr || typeof lastUpdatedStr !== 'string') return 999;
  
  const parts = lastUpdatedStr.split(':');
  if (parts.length !== 3) return 999;
  
  const devH = parseInt(parts[0], 10);
  const devM = parseInt(parts[1], 10);
  const devS = parseInt(parts[2], 10);
  
  if (isNaN(devH) || isNaN(devM) || isNaN(devS)) return 999;
  
  const devSeconds = devH * 3600 + devM * 60 + devS;
  
  const now = new Date();
  
  // Local client time in seconds
  const localH = now.getHours();
  const localM = now.getMinutes();
  const localS = now.getSeconds();
  const localSeconds = localH * 3600 + localM * 60 + localS;
  
  // UTC client time in seconds
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const utcS = now.getUTCSeconds();
  const utcSeconds = utcH * 3600 + utcM * 60 + utcS;
  
  // Difference
  const diffLocal = Math.abs(localSeconds - devSeconds);
  const diffUtc = Math.abs(utcSeconds - devSeconds);
  
  // Midnight wrapping
  const wrapLocal = 86400 - diffLocal;
  const wrapUtc = 86400 - diffUtc;
  
  return Math.min(diffLocal, wrapLocal, diffUtc, wrapUtc);
}

let lastProcessedTelemetryTime: string | null = null;
let simulationInterval: ReturnType<typeof setInterval> | null = null;

// Fallback helper to listen to local storage modifications and run telemetry simulation
function fallbackToLocalStorage(callback: (devices: Device[], mode: 'live' | 'simulated') => void): () => void {
  console.warn('[SmartTelemetry] Falling back to local storage simulator.');
  callback(getDevices(), 'simulated');
  
  const handleStorageChange = () => {
    callback(getDevices(), 'simulated');
  };
  
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('health_monitoring_storage_change', handleStorageChange);
    
    // Start local telemetry simulator to update readings in real-time
    if (!simulationInterval) {
      simulationInterval = setInterval(() => {
        const devices = getDevices();
        const updated = devices.map(d => {
          const now = new Date();
          const last = d.history[0];
          
          let bpm = last ? last.bpm : 72;
          let spo2 = last ? last.spo2 : 98;
          let temp = last ? last.temp : 36.6;
          
          // Gently walk the values
          bpm = Math.max(50, Math.min(130, bpm + Math.round((Math.random() - 0.5) * 6)));
          spo2 = Math.max(88, Math.min(100, spo2 + (Math.random() > 0.8 ? (Math.random() > 0.5 ? 1 : -1) : 0)));
          temp = Math.max(34.5, Math.min(41.0, temp + (Math.random() - 0.5) * 0.3));
          
          const { status } = evaluateVitalsStatus(bpm, spo2, temp);
          
          const newReading: HealthReading = {
            bpm,
            spo2,
            temp,
            timestamp: now.toISOString(),
            status,
            notes: `Simulated bedside update. Battery: ${d.battery || 95}%.`
          };
          
          let history = [newReading, ...d.history];
          if (history.length > 50) {
            history = history.slice(0, 50);
          }
          
          return {
            ...d,
            status,
            lastUpdated: now.toISOString(),
            history,
            battery: Math.max(1, (d.battery || 95) - (Math.random() > 0.98 ? 1 : 0)),
            onlineStatus: 'online',
            lastUpdatedStr: now.toLocaleTimeString([], { hour12: false })
          };
        });
        
        localStorage.setItem('health_monitoring_devices', JSON.stringify(updated));
        window.dispatchEvent(new Event('health_monitoring_storage_change'));
      }, 3000);
    }
  }
  
  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('health_monitoring_storage_change', handleStorageChange);
    }
    if (simulationInterval) {
      clearInterval(simulationInterval);
      simulationInterval = null;
    }
  };
}

/**
 * Subscribes to live patient telemetry nodes.
 * Listens to the `/HealthData` path where the physical device sends its core values.
 */
export function subscribeToLiveDevices(callback: (devices: Device[], mode: 'live' | 'simulated') => void): () => void {
  if (!database) {
    return fallbackToLocalStorage(callback);
  }

  let isFallbackActive = false;
  let fallbackUnsubscribe = () => {};

  // 1. Subscribe to `/devices` for central ward data and bedside clinical notes
  const devicesRef = ref(database, 'devices');
  const unsubscribeDevices = onValue(devicesRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      callback([], 'live');
      return;
    }

    const parsedDevices: Device[] = [];
    const mockIdsToDelete = ['dev-001', 'dev-002', 'dev-003'];
    
    mockIdsToDelete.forEach(id => {
      if (data[id]) {
        remove(ref(database, `devices/${id}`)).catch(err => console.error(`Error deleting mock device ${id}:`, err));
      }
    });

    Object.keys(data).forEach((key) => {
      const item = data[key];
      if (item && item.id && !mockIdsToDelete.includes(item.id)) {
        // Calculate dynamic online/offline status
        const lastUpdatedStr = item.lastUpdatedStr;
        const secondsSinceUpdate = getSecondsSinceLastUpdate(lastUpdatedStr);
        const isOffline = secondsSinceUpdate > 15;
        
        parsedDevices.push({
          ...item,
          onlineStatus: isOffline ? 'offline' : 'online',
          status: isOffline ? 'critical' : item.status
        });
      }
    });

    // Save to local storage for offline / detail panel fallback
    parsedDevices.forEach(d => saveDevice(d));
    parsedDevices.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());
    callback(parsedDevices, 'live');
  }, (error) => {
    console.error('[SmartTelemetry] Firebase devices node read error: ', error);
    if (!isFallbackActive) {
      isFallbackActive = true;
      fallbackUnsubscribe = fallbackToLocalStorage(callback);
    }
  });

  // 2. Subscribe to `/HealthData` to update patient nodes dynamically
  let unsubscribeHealth = () => {};
  try {
    const healthDataRef = ref(database, 'HealthData');
    unsubscribeHealth = onValue(healthDataRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const deviceId = data.device_id || 'device_001';
      const lastUpdatedStr = data.last_updated;

      // Prevent processing duplicate telemetry packets
      if (lastUpdatedStr && lastUpdatedStr === lastProcessedTelemetryTime) return;
      if (lastUpdatedStr) {
        lastProcessedTelemetryTime = lastUpdatedStr;
      }

      const bpm = Number(data.bpm || 0);
      const spo2 = Number(data.spo2 || 0);
      const temp = Number(data.temperature !== undefined ? data.temperature : (data.temp || 36.6));
      const battery = Number(data.battery !== undefined ? data.battery : 100);
      const rawStatus = data.status || 'online';

      // Skip empty or invalid packet structures
      if (bpm === 0 && spo2 === 0 && temp === 0) return;

      // Parse HH:MM:SS time string
      let timestamp = new Date().toISOString();
      const parts = lastUpdatedStr ? lastUpdatedStr.split(':') : [];
      if (parts.length === 3) {
        const d = new Date();
        d.setHours(parseInt(parts[0], 10));
        d.setMinutes(parseInt(parts[1], 10));
        d.setSeconds(parseInt(parts[2], 10));
        d.setMilliseconds(0);
        timestamp = d.toISOString();
      }

      // Read device and append new reading to history
      const deviceRef = ref(database, `devices/${deviceId}`);
      get(deviceRef).then((devSnap) => {
        const existing = devSnap.val() as Device | null;
        let history: HealthReading[] = existing?.history ? [...existing.history] : [];
        const { status: vitalsStatus } = evaluateVitalsStatus(bpm, spo2, temp);

        const newReading: HealthReading = {
          bpm,
          spo2,
          temp,
          timestamp,
          status: vitalsStatus,
          notes: `Signal update. Battery: ${battery}%. Device State: ${rawStatus}.`
        };

        const isDuplicate = history.some(h => h.timestamp === timestamp);
        if (!isDuplicate) {
          history.unshift(newReading);
          if (history.length > 50) {
            history = history.slice(0, 50);
          }
        }

        const updatedDevice: Device = {
          id: deviceId,
          userName: existing?.userName || `Patient Monitor ${deviceId.slice(-3).toUpperCase()}`,
          status: vitalsStatus,
          lastUpdated: timestamp,
          history,
          battery,
          onlineStatus: 'online',
          lastUpdatedStr
        };

        set(deviceRef, updatedDevice).catch(err => {
          console.error('[SmartTelemetry] Failed to write updated telemetry in Firebase:', err);
        });
      }).catch(err => {
        console.error('[SmartTelemetry] Failed to read device snapshot for telemetry sync:', err);
      });
    }, (error) => {
      console.error('[SmartTelemetry] Firebase HealthData node read error: ', error);
    });
  } catch (e) {
    console.error('[SmartTelemetry] HealthData subscription failure:', e);
  }

  return () => {
    unsubscribeDevices();
    unsubscribeHealth();
    if (isFallbackActive) {
      fallbackUnsubscribe();
    }
  };
}

