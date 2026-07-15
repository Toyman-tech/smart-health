export interface HealthReading {
  bpm: number;
  spo2: number;
  temp: number; // in Celsius
  timestamp: string;
  status: 'normal' | 'warning' | 'critical' | 'sensor_unplaced';
  notes: string;
}

export interface Device {
  id: string;
  userName: string;
  status: 'normal' | 'warning' | 'critical' | 'sensor_unplaced';
  lastUpdated: string;
  history: HealthReading[];
  battery?: number;
  onlineStatus?: 'online' | 'offline';
  lastUpdatedStr?: string;
}

const STORAGE_KEY = 'health_monitoring_devices';
const EVENT_NAME = 'health_monitoring_storage_change';

// Threshold check to determine reading severity
export function evaluateVitalsStatus(bpm: number, spo2: number, temp: number): {
  status: 'normal' | 'warning' | 'critical' | 'sensor_unplaced';
  notes: string;
} {
  if (bpm === 0 && spo2 === 0) {
    return { status: 'sensor_unplaced', notes: 'Place Sensor (Sensor Unplaced)' };
  }

  const issues: string[] = [];

  // Evaluate BPM (Normal: 60-100)
  if (bpm > 120 || bpm < 50) {
    issues.push(bpm > 120 ? `High heart rate (${bpm} BPM)` : `Low heart rate (${bpm} BPM)`);
  } else if ((bpm > 100 && bpm <= 120) || (bpm >= 50 && bpm < 60)) {
    issues.push(bpm > 100 ? `Elevated heart rate (${bpm} BPM)` : `Slightly low heart rate (${bpm} BPM)`);
  }

  // Evaluate SpO2 (Normal: >= 95%)
  if (spo2 < 92) {
    issues.push(`Critical blood oxygen (${spo2}%)`);
  } else if (spo2 >= 92 && spo2 < 95) {
    issues.push(`Low blood oxygen (${spo2}%)`);
  }

  // Evaluate Temperature (Normal: 36.1 - 37.2°C)
  if (temp > 39.0 || temp < 35.0) {
    issues.push(temp > 39.0 ? `High fever (${temp.toFixed(1)}°C)` : `Hypothermia (${temp.toFixed(1)}°C)`);
  } else if ((temp > 37.2 && temp <= 39.0) || (temp >= 35.0 && temp < 36.1)) {
    issues.push(temp > 37.2 ? `Mild fever (${temp.toFixed(1)}°C)` : `Low body temp (${temp.toFixed(1)}°C)`);
  }

  const isCritical = bpm > 120 || bpm < 50 || spo2 < 92 || temp > 39.0 || temp < 35.0;
  const isWarning = !isCritical && (
    (bpm > 100 && bpm <= 120) || 
    (bpm >= 50 && bpm < 60) || 
    (spo2 >= 92 && spo2 < 95) || 
    (temp > 37.2 && temp <= 39.0) || 
    (temp >= 35.0 && temp < 36.1)
  );

  if (isCritical) {
    return { status: 'critical', notes: issues.join(', ') || 'Critical vitals detected' };
  } else if (isWarning) {
    return { status: 'warning', notes: issues.join(', ') || 'Warning vitals detected' };
  }

  return { status: 'normal', notes: 'All vitals within normal parameters' };
}

// Dispatch event to sync state locally in the same window, since standard 'storage' event only fires in other tabs.
function notifyStorageChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(EVENT_NAME));
  }
}

export function getDevices(): Device[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(STORAGE_KEY);
  if (!data) {
    return initializeMockDevices();
  }
  try {
    return JSON.parse(data);
  } catch (e) {
    console.error('Failed to parse devices data', e);
    return [];
  }
}

export function getDevice(id: string): Device | null {
  const devices = getDevices();
  return devices.find(d => d.id === id) || null;
}

export function saveDevice(device: Device): void {
  if (typeof window === 'undefined') return;
  const devices = getDevices();
  const index = devices.findIndex(d => d.id === device.id);
  
  if (index !== -1) {
    devices[index] = device;
  } else {
    devices.push(device);
  }
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
  notifyStorageChange();
}

export function addReading(
  deviceId: string, 
  reading: { bpm: number; spo2: number; temp: number }
): Device {
  const devices = getDevices();
  let device = devices.find(d => d.id === deviceId);
  
  const timestamp = new Date().toISOString();
  const { status, notes } = evaluateVitalsStatus(reading.bpm, reading.spo2, reading.temp);
  
  const fullReading: HealthReading = {
    ...reading,
    timestamp,
    status,
    notes
  };

  if (!device) {
    // Create new device if not found
    device = {
      id: deviceId,
      userName: `Patient #${deviceId.substring(0, 4).toUpperCase()}`,
      status,
      lastUpdated: timestamp,
      history: [fullReading]
    };
    devices.push(device);
  } else {
    device.status = status;
    device.lastUpdated = timestamp;
    device.history.unshift(fullReading); // Prepend so latest is first
    
    // Limit history length to keep localstorage performant (last 100 entries)
    if (device.history.length > 100) {
      device.history = device.history.slice(0, 100);
    }
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
  notifyStorageChange();
  return device;
}

export function deleteDevice(id: string): void {
  if (typeof window === 'undefined') return;
  let devices = getDevices();
  devices = devices.filter(d => d.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
  notifyStorageChange();
}

export function clearAllData(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
  notifyStorageChange();
}

// Subscribes to storage changes (handles both other tabs via 'storage' and same tab via custom events)
export function subscribeToDevices(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  
  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      callback();
    }
  };
  
  const handleLocalChange = () => {
    callback();
  };

  window.addEventListener('storage', handleStorageChange);
  window.addEventListener(EVENT_NAME, handleLocalChange);

  return () => {
    window.removeEventListener('storage', handleStorageChange);
    window.removeEventListener(EVENT_NAME, handleLocalChange);
  };
}

// Utility to create default devices so the admin dashboard isn't blank on start
function initializeMockDevices(): Device[] {
  return [];
}
