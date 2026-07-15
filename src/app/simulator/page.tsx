'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function SimulatorRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/');
  }, [router]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#070a13' }}>
      <p style={{ color: '#94a3b8', fontSize: '1.2rem', fontFamily: 'monospace' }}>Redirecting to Central Ward Telemetry Hub...</p>
    </div>
  );
}
