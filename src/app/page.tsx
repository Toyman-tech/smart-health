'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  Device, 
  HealthReading
} from '@/lib/storage';
import { subscribeToLiveDevices, getSecondsSinceLastUpdate } from '@/lib/firebase';



export default function BedsideMonitorPage() {
  const [mounted, setMounted] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [targetDeviceId, setTargetDeviceId] = useState<string>('device_001');

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [syncMode, setSyncMode] = useState<'live' | 'simulated'>('simulated');

  // Load state and setup Firebase database subscription
  useEffect(() => {
    setTimeout(() => {
      setMounted(true);
      // Read cached device ID if set
      const savedId = localStorage.getItem('bedside_monitor_id');
      if (savedId) {
        setTargetDeviceId(savedId);
      }
    }, 0);

    const unsubscribe = subscribeToLiveDevices((updatedDevices, mode) => {
      setDevices(updatedDevices);
      setSyncMode(mode);
    });

    return () => unsubscribe();
  }, []);

  // Find active device in the database list
  let device = devices.find(d => d.id === targetDeviceId) || null;
  
  // If target device is not in list but we have other devices, fallback to the first active device
  if (!device && devices.length > 0) {
    device = devices[0];
  }

  // Periodic checker to track seconds elapsed since last Firebase packet
  useEffect(() => {
    const interval = setInterval(() => {
      if (device?.lastUpdatedStr) {
        const seconds = getSecondsSinceLastUpdate(device.lastUpdatedStr);
        setElapsedSeconds(seconds);
      } else if (device?.lastUpdated) {
        // Fallback for mock data timestamps
        const seconds = Math.round((Date.now() - new Date(device.lastUpdated).getTime()) / 1000);
        setElapsedSeconds(seconds);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [device]);

  // Vitals evaluations
  const latestReading = device?.history?.[0] || null;
  const isDeviceOffline = elapsedSeconds > 15;

  


  // Render ECG trend line chart
  const renderSVGChart = (history: HealthReading[], metric: 'bpm' | 'spo2' | 'temp') => {
    if (!history || history.length < 2) {
      return (
        <text x="250" y="75" textAnchor="middle" fill="var(--text-dark)" fontSize="13" fontFamily="monospace">
          [ECG Signal Initialising - Awaiting Live Feed]
        </text>
      );
    }

    const points = [...history.slice(0, 15)].reverse();
    const width = 500;
    const height = 150;
    const padding = 15;

    let minVal = 0;
    let maxVal = 100;
    let color = '';

    if (metric === 'bpm') {
      minVal = 40;
      maxVal = 160;
      color = 'var(--bpm)';
    } else if (metric === 'spo2') {
      minVal = 75;
      maxVal = 100;
      color = 'var(--spo2)';
    } else {
      minVal = 32;
      maxVal = 42;
      color = 'var(--temp)';
    }

    const coordinates = points.map((p, idx) => {
      const val = p[metric];
      const x = padding + (idx / (points.length - 1)) * (width - 2 * padding);
      const clampedVal = Math.max(minVal, Math.min(maxVal, val));
      const y = height - padding - ((clampedVal - minVal) / (maxVal - minVal)) * (height - 2 * padding);
      return { x, y, val, time: new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
    });

    let pathD = `M ${coordinates[0].x} ${coordinates[0].y}`;
    for (let i = 1; i < coordinates.length; i++) {
      pathD += ` L ${coordinates[i].x} ${coordinates[i].y}`;
    }

    const areaD = `${pathD} L ${coordinates[coordinates.length - 1].x} ${height - padding} L ${coordinates[0].x} ${height - padding} Z`;

    return (
      <>
        <defs>
          <filter id={`glow-${metric}`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <pattern id="bedside-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <rect width="20" height="20" fill="none" stroke="rgba(255, 255, 255, 0.03)" strokeWidth="0.5" />
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255, 255, 255, 0.01)" strokeWidth="0.25" />
          </pattern>
        </defs>

        <rect width="100%" height="100%" fill="url(#bedside-grid)" rx="6" />

        <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(255,255,255,0.02)" strokeWidth="1" />
        <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="rgba(255,255,255,0.02)" strokeWidth="1" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />

        <path d={areaD} fill={`url(#grad-${metric})`} opacity="0.08" />

        <path d={pathD} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" filter={`url(#glow-${metric})`} />

        {coordinates.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r="4.5" fill="#ffffff" stroke={color} strokeWidth="2.5" />
        ))}
      </>
    );
  };

  if (!mounted) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', height: '100dvh', background: '#070a13', padding: '20px', textAlign: 'center', boxSizing: 'border-box' }}>
        <p style={{ color: '#94a3b8', fontSize: '1.1rem', fontFamily: 'monospace', margin: 0 }}>Initialising Bedside Monitor...</p>
      </div>
    );
  }

  // Determine alarming pulses
  const isAlarmActive = device && (device.status === 'critical' || device.status === 'warning' || device.status === 'sensor_unplaced');
  const alertColor = device?.status === 'critical' ? 'var(--critical)' : 'var(--warning)';
  let pulseDotClass = 'pulse-norm';
  if (isDeviceOffline) {
    pulseDotClass = 'pulse-crit';
  } else if (isAlarmActive) {
    pulseDotClass = device?.status === 'critical' ? 'pulse-crit' : 'pulse-warn';
  }

  return (
    <div style={styles.container} className={isDeviceOffline ? "flash-alarm-red" : ""}>
      {/* Top Monitor Header */}
      <header style={styles.header}>
        <div style={styles.logo}>
          <span style={{
            ...styles.pulseDot,
            backgroundColor: isDeviceOffline ? 'var(--critical)' : isAlarmActive ? alertColor : 'var(--normal)'
          }} className={pulseDotClass}></span>
          HEALTH MONITORING
          <span style={{
            fontSize: '0.75rem',
            padding: '3px 8px',
            borderRadius: '4px',
            backgroundColor: syncMode === 'live' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)',
            color: syncMode === 'live' ? 'var(--normal)' : 'var(--warning)',
            border: syncMode === 'live' ? '1px solid rgba(16, 185, 129, 0.25)' : '1px solid rgba(245, 158, 11, 0.25)',
            fontWeight: 600,
            textTransform: 'uppercase',
            fontFamily: 'sans-serif',
            letterSpacing: '0.5px'
          }}>
            {syncMode === 'live' ? '● Firebase Live' : '⚠ Simulated Local'}
          </span>
        </div>

        {/* Device ID & Battery Info Badges */}
        {device && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px', fontSize: '0.85rem' }} className="no-print device-info-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ color: 'var(--text-muted)' }}>DEVICE:</span>
              <code style={{ background: 'rgba(255,255,255,0.06)', padding: '4px 8px', borderRadius: '4px', color: '#fff', fontWeight: 600 }}>{device.id}</code>
            </div>
            {device.battery !== undefined && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--text-muted)' }}>BATTERY:</span>
                <span style={{ 
                  color: device.battery < 20 ? 'var(--critical)' : device.battery < 50 ? 'var(--warning)' : 'var(--normal)',
                  fontWeight: 600
                }}>
                  🔋 {device.battery}%
                </span>
              </div>
            )}
          </div>
        )}
        
        {/* Device ID quick switcher */}
        <div style={styles.deviceSwitcher} className="device-switcher">
          <Link href="/admin" style={styles.consoleLink} className="console-link">
            🎛️ Central Ward Station
          </Link>
        </div>
      </header>

      {/* Main Screen Layout */}
      {device ? (
        <main style={styles.main}>
          {/* Top Status Alarm Ribbon */}
          {isDeviceOffline ? (
            <div style={styles.offlineRibbon} className="pulse-crit">
              ⚠️ NO LIVE SIGNAL DETECTED — SYSTEM DISCONNECTED FOR OVER 15s
            </div>
          ) : device.status === 'sensor_unplaced' ? (
            <div style={{ ...styles.offlineRibbon, backgroundColor: 'var(--warning)', animation: 'pulse-warning 1.5s infinite' }}>
              ⚠️ SENSOR UNPLACED — PLEASE ATTACH SENSOR TO PATIENT
            </div>
          ) : isAlarmActive ? (
            <div style={{ ...styles.offlineRibbon, backgroundColor: alertColor, animation: 'pulse-critical 1.5s infinite' }}>
              ⚠️ ACTIVE CLINICAL ALARM — ABNORMAL VITALS DETECTED
            </div>
          ) : (
            <div style={styles.onlineRibbon}>
              💚 TELEMETRY ONLINE — SIGNAL STRENGTH NORMAL 
              {/* (Update interval: {elapsedSeconds}s) */}
            </div>
          )}



          {/* Vitals Digital Readouts */}
          <section style={styles.vitalsGrid} className="vitals-grid">
            {/* Heart Rate */}
            <div style={{ ...styles.vitalCard, borderColor: 'var(--bpm)' }} className="glass-card">
              <div style={styles.vitalHeader}>
                <span>HEART RATE (ECG)</span>
                <span style={{ color: 'var(--bpm)' }} className={!isDeviceOffline && latestReading && latestReading.bpm > 0 ? "heart-beat" : ""}>❤️</span>
              </div>
              <div style={styles.vitalContent}>
                <span style={{ ...styles.vitalValue, color: 'var(--bpm)' }}>
                  {latestReading ? latestReading.bpm : '--'}
                </span>
                <span style={styles.vitalUnit}>BPM</span>
              </div>
              <span style={styles.vitalDesc}>Threshold: 50 - 120 bpm</span>
            </div>

            {/* Blood Oxygen */}
            <div style={{ ...styles.vitalCard, borderColor: 'var(--spo2)' }} className="glass-card">
              <div style={styles.vitalHeader}>
                <span>BLOOD OXYGEN (SpO₂)</span>
                <span style={{ color: 'var(--spo2)' }}>💧</span>
              </div>
              <div style={styles.vitalContent}>
                <span style={{ ...styles.vitalValue, color: 'var(--spo2)' }}>
                  {latestReading ? latestReading.spo2 : '--'}
                </span>
                <span style={styles.vitalUnit}>%</span>
              </div>
              <span style={styles.vitalDesc}>Normal limit: &ge; 95%</span>
            </div>

            {/* Temperature */}
            <div style={{ ...styles.vitalCard, borderColor: 'var(--temp)' }} className="glass-card">
              <div style={styles.vitalHeader}>
                <span>CORE TEMPERATURE</span>
                <span style={{ color: 'var(--temp)' }}>🌡️</span>
              </div>
              <div style={styles.vitalContent}>
                <span style={{ ...styles.vitalValue, color: 'var(--temp)' }}>
                  {latestReading ? latestReading.temp.toFixed(1) : '--'}
                </span>
                <span style={styles.vitalUnit}>°C</span>
              </div>
              <span style={styles.vitalDesc}>
                Fahrenheit: {latestReading ? ((latestReading.temp * 9/5) + 32).toFixed(1) : '--'}°F
              </span>
            </div>
          </section>

          {/* Vitals Trends Graph Card */}
          <section style={styles.trendsGrid} className="trends-grid">
            <div style={styles.chartWrapper} className="glass-card">
              <h3 style={styles.chartHeading}>ECG Heart Rate History (BPM)</h3>
              <svg viewBox="0 0 500 150" style={styles.svgChart} className="svg-chart">
                <defs>
                  <linearGradient id="grad-bpm" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--bpm)" stopOpacity="0.4"/>
                    <stop offset="100%" stopColor="var(--bpm)" stopOpacity="0"/>
                  </linearGradient>
                </defs>
                {renderSVGChart(device.history, 'bpm')}
              </svg>
            </div>

            <div style={styles.chartWrapper} className="glass-card">
              <h3 style={styles.chartHeading}>Arterial SpO₂ Trend (%)</h3>
              <svg viewBox="0 0 500 150" style={styles.svgChart} className="svg-chart">
                <defs>
                  <linearGradient id="grad-spo2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--spo2)" stopOpacity="0.4"/>
                    <stop offset="100%" stopColor="var(--spo2)" stopOpacity="0"/>
                  </linearGradient>
                </defs>
                {renderSVGChart(device.history, 'spo2')}
              </svg>
            </div>
          </section>

          {/* Bedside Observation Log */}
          <section style={styles.notesSection} className="glass-card">
            <div style={styles.logsContainer}>
              <h4 style={styles.logsHeading}>Patient Monitoring Log History</h4>
              <div style={styles.logsList}>
                {device.history.slice(0, 15).map((log, index) => (
                  <div key={index} style={styles.logItem} className="log-item">
                    <span style={styles.logTime}>[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span style={{ 
                      ...styles.logStatus,
                      color: log.status === 'critical' ? 'var(--critical)' : log.status === 'warning' ? 'var(--warning)' : 'var(--normal)'
                    }}>
                      {log.status.toUpperCase()}
                    </span>
                    <span style={styles.logValText}>
                      HR: <strong>{log.bpm} bpm</strong> | SpO₂: <strong>{log.spo2}%</strong> | Temp: <strong>{log.temp}°C</strong>
                    </span>
                    <span style={styles.logNotes}>{log.notes}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      ) : (
        <div style={styles.emptyContainer} className="glass-card">
          <h3>No Active Signal Source Found</h3>
          <p style={{ color: 'var(--text-muted)', marginTop: '10px' }}>
            Verify that your device is powered on and writing telemetry to path <code>/HealthData</code> under the database <code>{process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL}</code>.
          </p>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: 'transparent',
    transition: 'background-color 0.5s ease',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px 40px',
    borderBottom: '1px solid var(--border-color)',
    background: 'rgba(7, 10, 19, 0.85)',
    backdropFilter: 'blur(12px)',
  },
  logo: {
    fontSize: '1.3rem',
    fontWeight: 700,
    color: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontFamily: 'monospace',
    letterSpacing: '1px',
    textTransform: 'uppercase' as const,
  },
  pulseDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
  },
  deviceSwitcher: {
    display: 'flex',
    alignItems: 'center',
    gap: '15px',
  },
  select: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    color: '#ffffff',
    padding: '6px 12px',
    fontSize: '0.85rem',
    outline: 'none',
    cursor: 'pointer',
    fontFamily: 'monospace',
  },
  consoleLink: {
    color: '#ffffff',
    textDecoration: 'none',
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
    border: '1px solid rgba(99, 102, 241, 0.3)',
    padding: '6px 14px',
    borderRadius: '6px',
    fontSize: '0.85rem',
    fontWeight: 600,
    transition: 'all var(--transition-fast)',
  },
  main: {
    flex: 1,
    padding: '30px 40px',
    maxWidth: '1200px',
    width: '100%',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '24px',
  },
  offlineRibbon: {
    backgroundColor: 'var(--critical)',
    color: '#ffffff',
    padding: '10px 20px',
    borderRadius: '8px',
    fontSize: '0.9rem',
    fontWeight: 700,
    textAlign: 'center' as const,
    letterSpacing: '0.5px',
    boxShadow: '0 4px 12px rgba(239, 68, 68, 0.25)',
  },
  onlineRibbon: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    border: '1px solid rgba(16, 185, 129, 0.25)',
    color: 'var(--normal)',
    padding: '10px 20px',
    borderRadius: '8px',
    fontSize: '0.9rem',
    fontWeight: 700,
    textAlign: 'center' as const,
    letterSpacing: '0.5px',
  },
  patientInfoCard: {
    padding: '24px',
  },
  patientMetaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '20px',
  },
  infoLabel: {
    fontSize: '0.7rem',
    fontWeight: 600,
    color: 'var(--text-dark)',
    letterSpacing: '1px',
    display: 'block',
    marginBottom: '4px',
    textTransform: 'uppercase' as const,
  },
  patientName: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#ffffff',
  },
  infoVal: {
    fontSize: '1.1rem',
    fontWeight: 500,
    color: 'var(--text-main)',
  },
  infoValCode: {
    fontSize: '1rem',
    color: 'var(--text-main)',
  },
  vitalsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '20px',
  },
  vitalCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '20px 24px',
    borderLeftWidth: '5px',
  },
  vitalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.8rem',
    color: 'var(--text-muted)',
    fontWeight: 600,
    letterSpacing: '0.5px',
  },
  vitalContent: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    marginTop: '10px',
    marginBottom: '6px',
  },
  vitalValue: {
    fontSize: '3.2rem',
    fontWeight: 700,
    lineHeight: 1,
  },
  vitalUnit: {
    fontSize: '1.2rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
  },
  vitalDesc: {
    fontSize: '0.8rem',
    color: 'var(--text-dark)',
  },
  trendsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '20px',
  },
  chartWrapper: {
    padding: '20px',
  },
  chartHeading: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#ffffff',
    marginBottom: '15px',
    letterSpacing: '0.5px',
  },
  svgChart: {
    width: '100%',
    height: '150px',
    background: 'rgba(0, 5, 10, 0.95)',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.03)',
  },
  notesSection: {
    padding: '24px',
  },
  sectionHeading: {
    fontSize: '1.15rem',
    fontWeight: 600,
    color: '#ffffff',
    marginBottom: '15px',
  },
  noteForm: {
    display: 'flex',
    gap: '15px',
    marginBottom: '20px',
  },
  noteInput: {
    flex: 1,
    background: 'rgba(0, 0, 0, 0.25)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: '#ffffff',
    padding: '12px 16px',
    fontSize: '0.95rem',
    outline: 'none',
  },
  logsContainer: {
    borderTop: '1px solid var(--border-color)',
    paddingTop: '20px',
  },
  logsHeading: {
    fontSize: '0.9rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    marginBottom: '12px',
    letterSpacing: '0.5px',
  },
  logsList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '10px',
    maxHeight: '240px',
    overflowY: 'auto' as const,
    paddingRight: '6px',
  },
  logItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontSize: '0.85rem',
    borderBottom: '1px solid rgba(255,255,255,0.02)',
    paddingBottom: '8px',
  },
  logTime: {
    fontFamily: 'monospace',
    color: 'var(--text-dark)',
  },
  logStatus: {
    fontWeight: 700,
    fontSize: '0.75rem',
    minWidth: '55px',
  },
  logValText: {
    color: 'var(--text-muted)',
  },
  logNotes: {
    color: 'var(--spo2)',
    marginLeft: '10px',
    fontStyle: 'italic',
  },
  emptyContainer: {
    padding: '60px 40px',
    textAlign: 'center' as const,
    maxWidth: '600px',
    margin: '100px auto',
  },
};
