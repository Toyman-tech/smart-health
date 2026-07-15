'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  Device, 
  HealthReading
} from '@/lib/storage';
import { subscribeToLiveDevices, getSecondsSinceLastUpdate } from '@/lib/firebase';



export default function ClinicalCentralStation() {
  const [mounted, setMounted] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<'all' | 'critical' | 'warning' | 'normal'>('all');
  

  const [acknowledgedAlarms, setAcknowledgedAlarms] = useState<Record<string, boolean>>({});
  const [currentTime, setCurrentTime] = useState<number>(() => Date.now());
  const [syncMode, setSyncMode] = useState<'live' | 'simulated'>('simulated');

  // Setup Firebase subscription
  useEffect(() => {
    setTimeout(() => {
      setMounted(true);
    }, 0);

    const unsubscribe = subscribeToLiveDevices((updatedDevices, mode) => {
      setDevices(updatedDevices);
      setSyncMode(mode);
    });

    // Run tick interval to calculate offline state triggers in real-time
    const tick = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(tick);
    };
  }, []);

  // Helper to verify if a device has timed out (>15s)
  const checkIsOffline = (dev: Device) => {
    if (dev.lastUpdatedStr) {
      return getSecondsSinceLastUpdate(dev.lastUpdatedStr) > 15;
    }
    return (currentTime - new Date(dev.lastUpdated).getTime()) > 15000;
  };

  // Filter devices based on status
  const filteredDevices = devices.filter(d => {
    const isOffline = checkIsOffline(d);
    const resolvedStatus = isOffline ? 'critical' : d.status;

    if (filterStatus === 'all') return true;
    if (filterStatus === 'warning') return resolvedStatus === 'warning' || resolvedStatus === 'sensor_unplaced';
    return resolvedStatus === filterStatus;
  });

  const activeDeviceId = (selectedDeviceId && devices.some(d => d.id === selectedDeviceId)) 
    ? selectedDeviceId 
    : (devices[0]?.id || null);
  const selectedDevice = devices.find(d => d.id === activeDeviceId) || null;
  const selectedOffline = selectedDevice ? checkIsOffline(selectedDevice) : false;

  // Compute aggregate totals
  const totalDevices = devices.length;
  const criticalCount = devices.filter(d => d.status === 'critical' || checkIsOffline(d)).length;
  const warningCount = devices.filter(d => (d.status === 'warning' || d.status === 'sensor_unplaced') && !checkIsOffline(d)).length;
  const normalCount = devices.filter(d => d.status === 'normal' && !checkIsOffline(d)).length;

  let averageBpm = 0;
  let averageSpo2 = 0;
  let averageTemp = 0;

  // Compute averages for all devices that have telemetry history
  const devicesWithHistory = devices.filter(d => d.history && d.history.length > 0);
  if (devicesWithHistory.length > 0) {
    const activeReadings = devicesWithHistory
      .map(d => d.history[0])
      .filter(Boolean);

    if (activeReadings.length > 0) {
      averageBpm = Math.round(activeReadings.reduce((sum, r) => sum + r.bpm, 0) / activeReadings.length);
      averageSpo2 = Math.round(activeReadings.reduce((sum, r) => sum + r.spo2, 0) / activeReadings.length);
      averageTemp = Number((activeReadings.reduce((sum, r) => sum + r.temp, 0) / activeReadings.length).toFixed(1));
    }
  }



  // Handle toggle alarm acknowledge
  const handleAcknowledgeAlarm = (deviceId: string) => {
    setAcknowledgedAlarms(prev => ({
      ...prev,
      [deviceId]: !prev[deviceId]
    }));
  };

  // Reset acknowledgment when a patient becomes healthy again
  useEffect(() => {
    devices.forEach(d => {
      if (d.status === 'normal' && acknowledgedAlarms[d.id]) {
        setAcknowledgedAlarms(prev => {
          const next = { ...prev };
          delete next[d.id];
          return next;
        });
      }
    });
  }, [devices, acknowledgedAlarms]);

  // Handle Export CSV
  const handleExportCSV = (device: Device) => {
    if (!device || device.history.length === 0) return;
    
    const headers = ['Timestamp', 'Heart Rate (BPM)', 'Blood Oxygen (SpO2 %)', 'Temperature (C)', 'Temperature (F)', 'Status Alert', 'Clinical Notes'];
    
    const rows = device.history.map(h => {
      const timestamp = new Date(h.timestamp).toISOString();
      const bpm = h.bpm;
      const spo2 = h.spo2;
      const tempC = h.temp.toFixed(1);
      const tempF = ((h.temp * 9/5) + 32).toFixed(1);
      const status = h.status.toUpperCase();
      const notes = `"${(h.notes || '').replace(/"/g, '""')}"`;
      
      return [timestamp, bpm, spo2, tempC, tempF, status, notes].join(',');
    });
    
    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    const sanitizedName = device.userName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    link.setAttribute('download', `telemetry_report_${sanitizedName}_${device.id}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handlePrintReport = () => {
    if (typeof window !== 'undefined') {
      window.print();
    }
  };

  // Render SVG Trend Waveform on ECG Grid pattern
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
          <filter id={`glow-station-${metric}`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <pattern id="station-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <rect width="20" height="20" fill="none" stroke="rgba(255, 255, 255, 0.03)" strokeWidth="0.5" />
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255, 255, 255, 0.01)" strokeWidth="0.25" />
          </pattern>
        </defs>

        <rect width="100%" height="100%" fill="url(#station-grid)" rx="6" />

        <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(255,255,255,0.02)" strokeWidth="1" />
        <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="rgba(255,255,255,0.02)" strokeWidth="1" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />

        <path d={areaD} fill={`url(#grad-${metric})`} opacity="0.08" />

        <path d={pathD} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" filter={`url(#glow-station-${metric})`} />

        {coordinates.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r="4.5" fill="#ffffff" stroke={color} strokeWidth="2.5" />
        ))}
      </>
    );
  };

  if (!mounted) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', height: '100dvh', background: '#070a13', padding: '20px', textAlign: 'center', boxSizing: 'border-box' }}>
        <p style={{ color: '#94a3b8', fontSize: '1.1rem', fontFamily: 'monospace', margin: 0 }}>Initializing Central Station...</p>
      </div>
    );
  }

  return (
    <div style={styles.dashboardContainer} className="fade-in">
      {/* Top Navbar */}
      <nav style={styles.nav} className="no-print">
        <div style={styles.navBrand}>
          <div style={styles.navPulse} className={criticalCount > 0 ? 'pulse-crit' : warningCount > 0 ? 'pulse-warn' : 'pulse-norm'}></div>
          Admin Dashboard <span style={styles.badge}>Central Station</span>
          <span style={{
            fontSize: '0.7rem',
            padding: '3px 8px',
            borderRadius: '4px',
            backgroundColor: syncMode === 'live' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)',
            color: syncMode === 'live' ? 'var(--normal)' : 'var(--warning)',
            border: syncMode === 'live' ? '1px solid rgba(16, 185, 129, 0.25)' : '1px solid rgba(245, 158, 11, 0.25)',
            fontWeight: 600,
            textTransform: 'uppercase',
            fontFamily: 'sans-serif',
            letterSpacing: '0.5px',
            marginLeft: '10px'
          }}>
            {syncMode === 'live' ? '● Firebase Live' : '⚠ Simulated Local'}
          </span>
        </div>
        <div style={styles.navLinks}>
          <Link href="/" style={styles.bedsideLink}>
            🛌 View Attending Bedside Monitor
          </Link>
        </div>
      </nav>

      <main style={styles.main}>
        {/* Statistics Banner */}
        <section style={styles.statsGrid} className="stats-grid">
          <div style={styles.statCard} className="glass-card">
            <span style={styles.statLabel}>Active Device</span>
            <span style={styles.statVal}>{totalDevices}</span>
            <div style={styles.statStatusGrid}>
              <span style={{ color: 'var(--normal)' }}>● {normalCount} Normal</span>
              <span style={{ color: 'var(--warning)' }}>● {warningCount} Elevated</span>
              <span style={{ color: 'var(--critical)' }}>● {criticalCount} Alarm</span>
            </div>
          </div>
          
          <div style={{ ...styles.statCard, borderLeft: '4px solid var(--bpm)' }} className="glass-card">
            <span style={styles.statLabel}>WARD AVG HEART RATE</span>
            <span style={{ ...styles.statVal, color: 'var(--bpm)' }}>{averageBpm} <span style={styles.statUnit}>BPM</span></span>
            <span style={styles.statDesc}>Standard Range: 60 - 100 BPM</span>
          </div>

          <div style={{ ...styles.statCard, borderLeft: '4px solid var(--spo2)' }} className="glass-card">
            <span style={styles.statLabel}>WARD AVG OXYGEN SATURATION</span>
            <span style={{ ...styles.statVal, color: 'var(--spo2)' }}>{averageSpo2}<span style={styles.statUnit}>%</span></span>
            <span style={styles.statDesc}>Target Saturation: &ge; 95%</span>
          </div>

          <div style={{ ...styles.statCard, borderLeft: '4px solid var(--temp)' }} className="glass-card">
            <span style={styles.statLabel}>WARD AVG TEMPERATURE</span>
            <span style={{ ...styles.statVal, color: 'var(--temp)' }}>{averageTemp}<span style={styles.statUnit}>°C</span></span>
            <span style={styles.statDesc}>Attending Normal: 36.1 - 37.2°C</span>
          </div>
        </section>

        {/* Master-Detail Workspace */}
        <div style={styles.workspaceGrid} className={`workspace-grid ${selectedDeviceId ? 'has-selected' : ''}`}>
          {/* Left Sidebar Directory */}
          <div style={styles.sidebarPanel} className="glass-card no-print sidebar-panel">
            <div style={styles.sidebarHeader}>
              <h3 style={styles.panelTitle}>Patient Ward Directory</h3>
              
              <div style={styles.filterTabs}>
                <button 
                  onClick={() => setFilterStatus('all')}
                  style={{ ...styles.filterTab, backgroundColor: filterStatus === 'all' ? 'rgba(255,255,255,0.08)' : 'transparent', color: filterStatus === 'all' ? '#fff' : 'var(--text-muted)' }}
                >
                  All ({devices.length})
                </button>
                <button 
                  onClick={() => setFilterStatus('critical')}
                  style={{ ...styles.filterTab, backgroundColor: filterStatus === 'critical' ? 'rgba(239, 68, 68, 0.15)' : 'transparent', color: 'var(--critical)' }}
                >
                  Alarm ({devices.filter(d => d.status === 'critical' || checkIsOffline(d)).length})
                </button>
                <button 
                  onClick={() => setFilterStatus('warning')}
                  style={{ ...styles.filterTab, backgroundColor: filterStatus === 'warning' ? 'rgba(245, 158, 11, 0.15)' : 'transparent', color: 'var(--warning)' }}
                >
                  Warn ({devices.filter(d => (d.status === 'warning' || d.status === 'sensor_unplaced') && !checkIsOffline(d)).length})
                </button>
              </div>
            </div>

            {/* Patients directory scroll list */}
            <div style={styles.deviceList}>
              {filteredDevices.length === 0 ? (
                <p style={styles.emptyListText}>No active patient monitors found.</p>
              ) : (
                filteredDevices.map(d => {
                  const last = d.history[0];
                  
                  const isOffline = checkIsOffline(d);
                  const isAlarm = d.status === 'critical' || d.status === 'warning' || d.status === 'sensor_unplaced' || isOffline;
                  const isMuted = acknowledgedAlarms[d.id];
                  
                  let pulseClass = 'pulse-norm';
                  if (isAlarm && !isMuted) {
                    pulseClass = (isOffline || d.status === 'critical') ? 'pulse-crit' : 'pulse-warn';
                  }

                  let indicatorColor = 'var(--normal)';
                  if (isOffline || d.status === 'critical') indicatorColor = 'var(--critical)';
                  else if (d.status === 'warning' || d.status === 'sensor_unplaced') indicatorColor = 'var(--warning)';

                  return (
                    <div 
                      key={d.id} 
                      onClick={() => setSelectedDeviceId(d.id)}
                      style={{
                        ...styles.deviceItem,
                        backgroundColor: activeDeviceId === d.id ? 'rgba(99,102,241,0.08)' : 'rgba(255,255,255,0.01)',
                        borderColor: activeDeviceId === d.id ? 'var(--primary)' : 'var(--border-color)'
                      }}
                    >
                      <div style={styles.deviceItemHeader}>
                        <div style={styles.deviceNameGroup}>
                          <span style={styles.deviceItemName}>{d.userName}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {isOffline && (
                            <span style={{ fontSize: '0.6rem', color: 'var(--critical)', border: '1px solid var(--critical)', padding: '1px 5px', borderRadius: '4px', textTransform: 'uppercase' }}>OFFLINE</span>
                          )}
                          {isMuted && !isOffline && (
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', border: '1px solid var(--border-color)', padding: '1px 5px', borderRadius: '4px' }}>Muted</span>
                          )}
                          <div style={{ ...styles.statusIndicator, backgroundColor: indicatorColor }} className={pulseClass}></div>
                        </div>
                      </div>

                      {last ? (
                        <div style={{ ...styles.deviceItemVitals, opacity: isOffline ? 0.6 : 1 }} className="device-item-vitals">
                          <span style={{ color: 'var(--bpm)' }}>❤️ {last.bpm}</span>
                          <span style={{ color: 'var(--spo2)' }}>💧 {last.spo2}%</span>
                          <span style={{ color: 'var(--temp)' }}>🌡️ {last.temp.toFixed(1)}°C</span>
                        </div>
                      ) : (
                        <span style={styles.noTelemetryText}>Awaiting data packet</span>
                      )}

                      <span style={styles.deviceItemTime}>
                        Updated: {new Date(d.lastUpdated).toLocaleTimeString()}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Details Panel */}
          <div style={styles.detailsPanel} className="details-panel-container">
            {selectedDevice ? (
              <div style={styles.detailContainer} className="fade-in">
                {/* Mobile Back Button */}
                <button 
                  onClick={() => setSelectedDeviceId(null)}
                  className="btn btn-secondary mobile-only"
                  style={{ alignSelf: 'flex-start', gap: '6px', marginBottom: '10px', width: 'auto' }}
                >
                  ← Back to Directory
                </button>
                {/* Profile Header */}
                <div style={styles.profileHeaderCard} className="glass-card profile-header-card">
                  <div style={styles.profileMeta}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <h2 style={styles.profileTitle}>{selectedDevice.userName}</h2>
                    </div>
                    
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', marginTop: '8px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      <span><strong>Monitor Node ID:</strong> <code>{selectedDevice.id}</code></span>
                      {selectedDevice.battery !== undefined && (
                        <span><strong>Battery:</strong> {selectedDevice.battery}%</span>
                      )}
                    </div>
                  </div>
                  
                  <div style={styles.profileActions} className="no-print profile-actions">
                    {(selectedDevice.status === 'critical' || selectedDevice.status === 'warning' || selectedDevice.status === 'sensor_unplaced' || selectedOffline) && (
                      <button 
                        onClick={() => handleAcknowledgeAlarm(selectedDevice.id)}
                        className="btn"
                        style={{ 
                          fontSize: '0.85rem', 
                          padding: '8px 16px',
                          background: acknowledgedAlarms[selectedDevice.id] ? 'var(--border-color)' : 'var(--temp)',
                          border: acknowledgedAlarms[selectedDevice.id] ? '1px solid var(--border-color)' : 'none'
                        }}
                      >
                        🔔 {acknowledgedAlarms[selectedDevice.id] ? 'Acknowledge Alarm' : 'Silence Alert Alarms'}
                      </button>
                    )}
                    
                    <button 
                      onClick={() => handleExportCSV(selectedDevice)}
                      className="btn btn-secondary"
                      style={{ fontSize: '0.85rem', padding: '8px 16px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    >
                      Export CSV
                    </button>
                    
                    <button 
                      onClick={handlePrintReport}
                      className="btn btn-secondary"
                      style={{ fontSize: '0.85rem', padding: '8px 16px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    >
                      Print Report
                    </button>
                  </div>
                </div>

                {/* Alarm Status Banner for Selected Patient */}
                {selectedOffline ? (
                  <div style={styles.warningStrip}>
                    ⚠️ SIGNAL DISCONNECTED — Attending nurse verification required. Bedside telemetry has not reported for over 15 seconds.
                  </div>
                ) : selectedDevice.status === 'sensor_unplaced' ? (
                  <div style={{ ...styles.warningStrip, backgroundColor: 'var(--warning)' }}>
                    ⚠️ SENSOR UNPLACED — Please verify that the sensor is properly attached to the patient.
                  </div>
                ) : null}

                {/* Patient Readouts */}
                <div style={styles.vitalHighlightsGrid} className="vital-highlights-grid">
                  <div style={{ ...styles.highlightCard, borderTop: '4px solid var(--bpm)' }} className="glass-card">
                    <span style={styles.hLabel}>HEART RATE (ECG)</span>
                    <span style={styles.hVal}>
                      <span className={!selectedOffline && selectedDevice.history[0]?.bpm > 100 ? "heart-beat" : ""} style={{ marginRight: '5px' }}>❤️</span> 
                      {selectedDevice.history[0] ? selectedDevice.history[0].bpm : '--'} 
                      <span style={styles.hUnit}> BPM</span>
                    </span>
                    <span style={styles.hDesc}>Standard range: 60 - 100 BPM</span>
                  </div>

                  <div style={{ ...styles.highlightCard, borderTop: '4px solid var(--spo2)' }} className="glass-card">
                    <span style={styles.hLabel}>BLOOD OXYGEN (SpO₂)</span>
                    <span style={styles.hVal}>💧 {selectedDevice.history[0] ? selectedDevice.history[0].spo2 : '--'} <span style={styles.hUnit}> %</span></span>
                    <span style={styles.hDesc}>Hypoxia threshold: &lt; 92%</span>
                  </div>

                  <div style={{ ...styles.highlightCard, borderTop: '4px solid var(--temp)' }} className="glass-card">
                    <span style={styles.hLabel}>CORE TEMPERATURE</span>
                    <span style={styles.hVal}>🌡️ {selectedDevice.history[0] ? selectedDevice.history[0].temp.toFixed(1) : '--'} <span style={styles.hUnit}> °C</span></span>
                    <span style={styles.hDesc}>Fahrenheit: {selectedDevice.history[0] ? ((selectedDevice.history[0].temp * 9/5) + 32).toFixed(1) : '--'}°F</span>
                  </div>
                </div>

                {/* Trend Charts */}
                <div style={styles.chartsGrid} className="charts-grid">
                  <div style={styles.chartContainerCard} className="glass-card">
                    <h4 style={styles.chartTitle}>Heart Rate Trend (BPM)</h4>
                    <svg viewBox="0 0 500 150" style={styles.svgChart} className="svg-chart">
                      <defs>
                        <linearGradient id="grad-bpm" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--bpm)" stopOpacity="0.4"/>
                          <stop offset="100%" stopColor="var(--bpm)" stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      {renderSVGChart(selectedDevice.history, 'bpm')}
                    </svg>
                  </div>

                  <div style={styles.chartContainerCard} className="glass-card">
                    <h4 style={styles.chartTitle}>Oxygen Saturation (SpO₂ %)</h4>
                    <svg viewBox="0 0 500 150" style={styles.svgChart} className="svg-chart">
                      <defs>
                        <linearGradient id="grad-spo2" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--spo2)" stopOpacity="0.4"/>
                          <stop offset="100%" stopColor="var(--spo2)" stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      {renderSVGChart(selectedDevice.history, 'spo2')}
                    </svg>
                  </div>
                </div>



                {/* Log history table */}
                <div style={styles.tableCard} className="glass-card">
                  <h3 style={styles.panelTitle}>Bedside Telemetry & Log History</h3>
                  <div style={styles.tableScroll} className="table-scroll">
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={styles.th}>Timestamp</th>
                          <th style={styles.th}>Heart Rate</th>
                          <th style={styles.th}>Oxygen Saturation</th>
                          <th style={styles.th}>Temperature</th>
                          <th style={styles.th}>Alert Severity</th>
                          <th style={styles.th}>Clinical Remarks / Logs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedDevice.history.map((h, i) => {
                          const statusColor = h.status === 'critical' ? 'var(--critical)' : (h.status === 'warning' || h.status === 'sensor_unplaced') ? 'var(--warning)' : 'var(--normal)';
                          return (
                            <tr key={i} style={styles.tr}>
                              <td style={{ ...styles.td, fontFamily: 'monospace' }}>
                                {new Date(h.timestamp).toLocaleString()}
                              </td>
                              <td style={{ ...styles.td, color: 'var(--bpm)', fontWeight: 600 }}>{h.bpm} BPM</td>
                              <td style={{ ...styles.td, color: 'var(--spo2)', fontWeight: 600 }}>{h.spo2}%</td>
                              <td style={{ ...styles.td, color: 'var(--temp)', fontWeight: 600 }}>{h.temp.toFixed(1)}°C</td>
                              <td style={styles.td}>
                                <span style={{
                                  ...styles.tableStatusBadge,
                                  color: statusColor,
                                  background: h.status === 'critical' ? 'var(--critical-glow)' : (h.status === 'warning' || h.status === 'sensor_unplaced') ? 'var(--temp-glow)' : 'rgba(16, 185, 129, 0.1)',
                                  border: `1px solid ${statusColor}40`
                                }}>
                                  {h.status === 'sensor_unplaced' ? 'PLACE SENSOR' : h.status.toUpperCase()}
                                </span>
                              </td>
                              <td style={{ ...styles.td, color: h.notes.includes('[Bedside Note]') || h.notes.includes('[Central Station Note]') ? 'var(--spo2)' : 'var(--text-muted)', fontSize: '0.85rem' }}>{h.notes}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : (
              <div style={styles.emptyDetail} className="glass-card">
                <p>No patient selected in the central console.</p>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '10px' }}>
                  Please select a bed monitor feed from the left patient directory, or connect a physical device to populate live telemetry feeds.
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer style={styles.footer} className="no-print">
        <p style={styles.footerText}>SmartTelemetry Medical Systems. Clinical Ward Telemetry Central Station.</p>
      </footer>
    </div>
  );
}

const styles = {
  dashboardContainer: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: 'transparent',
  },
  nav: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px 40px',
    borderBottom: '1px solid var(--border-color)',
    background: 'rgba(7, 10, 19, 0.85)',
    backdropFilter: 'blur(10px)',
    position: 'sticky' as const,
    top: 0,
    zIndex: 100,
  },
  navBrand: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontFamily: 'monospace',
    letterSpacing: '1px',
    textTransform: 'uppercase' as const,
  },
  navPulse: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
  },
  badge: {
    fontSize: '0.75rem',
    padding: '3px 8px',
    background: 'rgba(6, 182, 212, 0.12)',
    color: 'var(--spo2)',
    border: '1px solid rgba(6, 182, 212, 0.25)',
    borderRadius: '12px',
    fontWeight: 600,
  },
  navLinks: {
    display: 'flex',
    alignItems: 'center',
    gap: '20px',
  },
  bedsideLink: {
    color: '#ffffff',
    textDecoration: 'none',
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
    border: '1px solid rgba(99, 102, 241, 0.3)',
    padding: '8px 16px',
    borderRadius: '8px',
    fontSize: '0.9rem',
    fontWeight: 600,
    transition: 'all var(--transition-fast)',
  },
  navSubtitle: {
    color: 'var(--text-dark)',
    fontSize: '0.9rem',
    fontWeight: 500,
    fontFamily: 'monospace',
  },
  main: {
    flex: 1,
    padding: '30px 40px',
    maxWidth: '1440px',
    width: '100%',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '30px',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: '20px',
  },
  statCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'center',
    padding: '20px 24px',
  },
  statLabel: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    letterSpacing: '1px',
    textTransform: 'uppercase' as const,
    marginBottom: '8px',
  },
  statVal: {
    fontSize: '2.2rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1,
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
  },
  statUnit: {
    fontSize: '1rem',
    fontWeight: 500,
    color: 'var(--text-muted)',
  },
  statDesc: {
    fontSize: '0.8rem',
    color: 'var(--text-dark)',
    marginTop: '10px',
  },
  statStatusGrid: {
    display: 'flex',
    gap: '15px',
    marginTop: '12px',
    fontSize: '0.85rem',
    fontWeight: 500,
  },
  workspaceGrid: {
    display: 'grid',
    gridTemplateColumns: '320px 1fr',
    gap: '30px',
    alignItems: 'start',
  },
  sidebarPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    maxHeight: 'calc(100vh - 280px)',
    minHeight: '400px',
  },
  sidebarHeader: {
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '18px',
    marginBottom: '15px',
  },
  panelTitle: {
    fontSize: '1.25rem',
    fontWeight: 600,
    color: '#ffffff',
    marginBottom: '12px',
  },
  filterTabs: {
    display: 'flex',
    gap: '6px',
  },
  filterTab: {
    flex: 1,
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    padding: '6px 4px',
    fontSize: '0.75rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    textAlign: 'center' as const,
  },
  deviceList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '10px',
    overflowY: 'auto' as const,
    flex: 1,
    paddingRight: '4px',
  },
  emptyListText: {
    color: 'var(--text-dark)',
    fontSize: '0.9rem',
    fontStyle: 'italic',
    textAlign: 'center' as const,
    padding: '30px 0',
  },
  deviceItem: {
    border: '1px solid var(--border-color)',
    borderRadius: '12px',
    padding: '14px',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  deviceItemHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  deviceNameGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  deviceItemName: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#ffffff',
  },
  deviceItemId: {
    fontFamily: 'monospace',
    fontSize: '0.75rem',
    color: 'var(--text-dark)',
  },
  statusIndicator: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
  },
  deviceItemVitals: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.8rem',
    background: 'rgba(0,0,0,0.15)',
    padding: '6px 10px',
    borderRadius: '6px',
    fontWeight: 500,
  },
  noTelemetryText: {
    fontSize: '0.8rem',
    color: 'var(--text-dark)',
    fontStyle: 'italic',
  },
  deviceItemTime: {
    fontSize: '0.75rem',
    color: 'var(--text-dark)',
    textAlign: 'right' as const,
  },
  detailsPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '30px',
  },
  detailContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '30px',
  },
  profileHeaderCard: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    gap: '20px',
  },
  profileMeta: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  profileTitle: {
    fontSize: '1.75rem',
    fontWeight: 700,
    color: '#ffffff',
  },
  profileSubtitle: {
    fontSize: '0.9rem',
    color: 'var(--text-muted)',
  },
  profileActions: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '10px',
  },
  warningStrip: {
    backgroundColor: 'var(--critical)',
    color: '#ffffff',
    padding: '12px 20px',
    borderRadius: '8px',
    fontSize: '0.9rem',
    fontWeight: 700,
    animation: 'pulse-critical 1.5s infinite',
    boxShadow: '0 4px 12px rgba(239, 68, 68, 0.25)',
  },
  vitalHighlightsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '20px',
  },
  highlightCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '20px',
  },
  hLabel: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    letterSpacing: '0.5px',
    marginBottom: '6px',
  },
  hVal: {
    fontSize: '1.8rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.2,
    marginBottom: '8px',
  },
  hUnit: {
    fontSize: '0.85rem',
    fontWeight: 500,
    color: 'var(--text-muted)',
  },
  hDesc: {
    fontSize: '0.8rem',
    color: 'var(--text-dark)',
  },
  chartsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '20px',
  },
  chartContainerCard: {
    padding: '20px',
  },
  chartTitle: {
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
  noteFormCard: {
    padding: '20px',
  },
  noteInput: {
    flex: 1,
    background: 'rgba(0,0,0,0.2)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: '#ffffff',
    padding: '12px 16px',
    fontSize: '0.95rem',
    outline: 'none',
    transition: 'all var(--transition-fast)',
  },
  tableCard: {
    padding: '24px',
  },
  tableScroll: {
    overflowX: 'auto' as const,
    marginTop: '15px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    textAlign: 'left' as const,
  },
  th: {
    borderBottom: '2px solid var(--border-color)',
    padding: '12px 16px',
    fontSize: '0.8rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  tr: {
    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
    transition: 'background var(--transition-fast)',
    ':hover': {
      background: 'rgba(255, 255, 255, 0.01)',
    },
  },
  td: {
    padding: '14px 16px',
    fontSize: '0.9rem',
    color: 'var(--text-main)',
  },
  tableStatusBadge: {
    fontSize: '0.75rem',
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: '4px',
    display: 'inline-block',
  },
  emptyDetail: {
    padding: '50px 30px',
    textAlign: 'center' as const,
    fontSize: '1.1rem',
  },
  footer: {
    borderTop: '1px solid var(--border-color)',
    padding: '30px 40px',
    textAlign: 'center' as const,
    background: 'rgba(7, 10, 19, 0.8)',
  },
  footerText: {
    fontSize: '0.85rem',
    color: 'var(--text-dark)',
  },
};
