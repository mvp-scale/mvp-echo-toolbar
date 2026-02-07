import React, { useRef, useEffect, useState } from 'react';

interface OceanVisualizerProps {
  isRecording: boolean;
  audioLevel: number;
}

interface VisualizationSettings {
  palette: string;
  flowSpeed: number;
  strokeAlpha: number;
  ringLayers: number;
  ringInner: number;
  ringGap: number;
  inner: { style: string; amp: number; phase: number };
  middle: { style: string; amp: number; phase: number };
  outer: { style: string; amp: number; phase: number };
  bars: { mirror: boolean; width: number; extent: number; edgeFade: number };
  fft: number;
  smoothing: number;
  gain: number;
  gate: number;
  line: number;
  trail: number;
  glow: boolean;
}

export default function OceanVisualizer({ isRecording, audioLevel }: OceanVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const analyserRef = useRef<{ node: AnalyserNode | null; dataF: Uint8Array | null; dataT: Uint8Array | null }>({
    node: null,
    dataF: null,
    dataT: null,
  });
  const audioContextRef = useRef<AudioContext>();
  const startTimeRef = useRef(performance.now());
  
  // Fixed ocean settings from your preferred configuration
  const settings: VisualizationSettings = {
    palette: "ocean",
    flowSpeed: 0.81,
    strokeAlpha: 0.5,
    ringLayers: 4,
    ringInner: 0.12,
    ringGap: 0.05,
    inner: { style: "beads", amp: 2, phase: 360 },
    middle: { style: "smooth", amp: 0.5, phase: 0 },
    outer: { style: "smooth", amp: 0.5, phase: 0 },
    bars: { mirror: true, width: 1, extent: 1, edgeFade: 3 },
    fft: 6267,
    smoothing: 0.5,
    gain: 0.2,
    gate: 0,
    line: 0.4,
    trail: 0.3,
    glow: true
  };
  
  // MVP Scale primary blue color wheel - calculated from HSL(227, 100%, 55%) and variations
  const oceanPalette = ['#0037ff', '#1a4cff', '#3366ff'];

  // Canvas setup and utilities
  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
    }
  };

  const clampPow2 = (v: number): number => {
    const p = Math.round(Math.log2(Math.max(32, Math.min(32768, v))));
    return 2 ** p;
  };

  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  const hexToRgb = (h: string): { r: number; g: number; b: number } => {
    h = (h || "").replace('#', '');
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16)
      };
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  };

  const rgbToStr = (obj: { r: number; g: number; b: number }, a: number): string => {
    const r = obj.r | 0, g = obj.g | 0, b = obj.b | 0;
    return `rgba(${r},${g},${b},${a == null ? 1 : a})`;
  };

  const flowColors = (time: number): string[] => {
    const spd = settings.flowSpeed;
    const t = time * spd;
    const f = (x: number): string => {
      const i = Math.floor(x) % oceanPalette.length;
      const j = (i + 1) % oceanPalette.length;
      const mix = x - Math.floor(x);
      const a = hexToRgb(oceanPalette[i]);
      const b = hexToRgb(oceanPalette[j]);
      return rgbToStr({
        r: lerp(a.r, b.r, mix),
        g: lerp(a.g, b.g, mix),
        b: lerp(a.b, b.b, mix)
      }, settings.strokeAlpha);
    };
    return [
      f(t % oceanPalette.length), 
      f((t + 1) % oceanPalette.length), 
      f((t + 2) % oceanPalette.length)
    ];
  };

  const gradientFor = (ctx: CanvasRenderingContext2D, time: number, x0: number, y0: number, x1: number, y1: number): CanvasGradient => {
    const cols = flowColors(time);
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    const n = cols.length;
    for (let i = 0; i < n; i++) {
      g.addColorStop(i / (n - 1), cols[i]);
    }
    return g;
  };

  const clearTrail = (ctx: CanvasRenderingContext2D, width: number, height: number, a: number) => {
    ctx.clearRect(0, 0, width, height);
  };

  const shape = (v: number, style: string, i: number): number => {
    const s = v < 0 ? -1 : 1;
    const a = Math.abs(v);
    if (style === 'peaks') return s * Math.pow(a, 0.5);
    if (style === 'spikes') return s * Math.pow(a, 2);
    if (style === 'beads') return (i % 8 < 2) ? s * a * 1.2 : 0;
    return v;
  };

  // Drawing functions
  const drawStyledRing = (ctx: CanvasRenderingContext2D, width: number, height: number, gain: number, radius: number, style: string, amp: number, phaseDeg: number) => {
    const d = analyserRef.current.dataT;
    if (!d) return;
    
    const len = d.length;
    const cx = width / 2, cy = height / 2;
    const ph = phaseDeg * Math.PI / 180;
    
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const t = i / len * Math.PI * 2 + ph;
      const raw = (d[i] - 128) / 128 * gain * amp;
      const v = shape(raw, style, i);
      const rr = radius + v * (radius * 0.7);
      const x = cx + Math.cos(t) * rr;
      const y = cy + Math.sin(t) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  };

  const drawBars = (ctx: CanvasRenderingContext2D, width: number, height: number, gain: number) => {
    const d = analyserRef.current.dataF;
    if (!d) return;
    
    const n = d.length;
    const cx = width / 2;
    const extent = settings.bars.extent;
    const maxI = Math.floor(n * 0.5 * extent);
    const fadePow = settings.bars.edgeFade;
    const w = settings.bars.width;
    
    ctx.save();
    ctx.lineWidth = w;
    for (let i = 0; i < maxI; i++) {
      const mag = d[i] / 255 * gain;
      const h = mag * (height * 0.6);
      const t = i / maxI;
      const alpha = Math.pow(1 - t, fadePow);
      ctx.globalAlpha = alpha;
      const x = t * (width / 2);
      
      ctx.beginPath();
      ctx.moveTo(cx - x, height / 2 - h / 2);
      ctx.lineTo(cx - x, height / 2 + h / 2);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(cx + x, height / 2 - h / 2);
      ctx.lineTo(cx + x, height / 2 + h / 2);
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawCircularOsc = (ctx: CanvasRenderingContext2D, width: number, height: number, gain: number, radius: number) => {
    const d = analyserRef.current.dataT;
    if (!d) return;
    
    const len = d.length;
    const cx = width / 2, cy = height / 2;
    
    ctx.save();
    ctx.lineWidth = settings.line * 0.7;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const t = i / len * Math.PI * 2;
      const v = (d[i] - 128) / 128 * gain * 0.7;
      const rr = radius + v * (radius * 0.45);
      const x = cx + Math.cos(t) * rr;
      const y = cy + Math.sin(t) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };

  const drawComposite = (ctx: CanvasRenderingContext2D, width: number, height: number, gain: number, time: number) => {
    const base = Math.min(width, height);
    const inner = base * settings.ringInner;
    const gap = base * settings.ringGap;
    const layers = settings.ringLayers;
    const styles = [settings.inner, settings.middle, settings.outer];
    
    // Draw rings
    for (let i = 0; i < layers; i++) {
      const r = inner + i * gap;
      const idx = (i === 0) ? 0 : (i === layers - 1 ? 2 : 1);
      ctx.save();
      ctx.globalAlpha = 0.9 - i * 0.18;
      drawStyledRing(ctx, width, height, gain * (1 - i * 0.06), r, styles[idx].style, styles[idx].amp, styles[idx].phase);
      ctx.restore();
    }
    
    // Circular oscilloscope
    drawCircularOsc(ctx, width, height, gain, inner + (layers - 0.5) * gap);
    
    // Bars
    ctx.save();
    drawBars(ctx, width, height, gain * 0.9);
    ctx.restore();
  };

  // Audio setup functions
  const setupAudio = async () => {
    try {
      // Always create a fresh audio context
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyserNode = audioContextRef.current.createAnalyser();
      analyserNode.fftSize = clampPow2(settings.fft);
      analyserNode.smoothingTimeConstant = settings.smoothing;
      
      analyserRef.current = {
        node: analyserNode,
        dataF: new Uint8Array(analyserNode.frequencyBinCount),
        dataT: new Uint8Array(analyserNode.fftSize),
      };
      
      if (isRecording) {
        // Connect to microphone when recording - exactly like the working ui-mock.html
        console.log('OceanVisualizer: Setting up microphone for recording');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const source = audioContextRef.current.createMediaStreamSource(stream);
        source.connect(analyserNode);
      } else {
        console.log('OceanVisualizer: Setup for static mode (no microphone)');
      }
      // When not recording, analyser node exists but no audio connected = will get flat data
    } catch (error) {
      console.warn('Audio setup failed:', error);
      // Create minimal analyser for static mode
      if (!analyserRef.current.node) {
        try {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
          const analyserNode = audioContextRef.current.createAnalyser();
          analyserNode.fftSize = 256;
          analyserRef.current = {
            node: analyserNode,
            dataF: new Uint8Array(analyserNode.frequencyBinCount),
            dataT: new Uint8Array(analyserNode.fftSize),
          };
        } catch (fallbackError) {
          console.error('Failed to create fallback audio context:', fallbackError);
        }
      }
    }
  };

  // Demo audio functions removed - using static visualization when not recording

  // Draw static idle state (no animation loop - saves GPU)
  const drawIdleState = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw static rings with gradient
    const cx = width / 2;
    const cy = height / 2;
    const base = Math.min(width, height);

    const g = gradientFor(ctx, 0, 0, 0, width, 0);
    ctx.strokeStyle = g;
    ctx.lineWidth = settings.line;
    ctx.globalAlpha = 0.3;

    // Draw simple static circles
    for (let i = 0; i < 4; i++) {
      const r = base * (0.12 + i * 0.05);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  };

  const animate = () => {
    const canvas = canvasRef.current;
    if (!canvas || !analyserRef.current.node) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    const sec = (performance.now() - startTimeRef.current) / 1000;

    // Always get audio data from analyser node (like working ui-mock.html)
    // When recording: real microphone data, when not recording: flat data (no audio source connected)
    analyserRef.current.node.getByteTimeDomainData(analyserRef.current.dataT!);
    analyserRef.current.node.getByteFrequencyData(analyserRef.current.dataF!);

    clearTrail(ctx, width, height, settings.trail);

    const g = gradientFor(ctx, sec, 0, 0, width, 0);
    ctx.lineWidth = settings.line;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = g;

    const gain = settings.gain;
    drawComposite(ctx, width, height, gain, sec);

    // Only continue animation loop if recording
    if (isRecording) {
      animationRef.current = requestAnimationFrame(animate);
    }
  };

  // Effects - Initial setup (no animation, just static display)
  useEffect(() => {
    resizeCanvas();
    // Draw static idle state on mount (no GPU-heavy animation)
    drawIdleState();

    const handleResize = () => {
      resizeCanvas();
      if (!isRecording) {
        drawIdleState();
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, []);

  // Start/stop animation when recording state changes
  useEffect(() => {
    // Cancel any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = undefined;
    }

    // Clean up existing audio context
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = undefined;
    }

    // Reset analyser reference
    analyserRef.current = {
      node: null,
      dataF: null,
      dataT: null
    };

    if (isRecording) {
      // Start animation when recording
      console.log('OceanVisualizer: Starting animation for recording');
      setupAudio().then(() => {
        startTimeRef.current = performance.now();
        animate();
      });
    } else {
      // Draw static state when not recording (no animation loop = no GPU usage)
      console.log('OceanVisualizer: Stopping animation, showing idle state');
      drawIdleState();
    }
  }, [isRecording]);

  return (
    <div className="relative w-full h-80 overflow-hidden">
      <canvas 
        ref={canvasRef} 
        className="w-full h-full"
        style={{
          filter: settings.glow ? 'drop-shadow(0 0 8px rgba(255,255,255,.25))' : 'none',
          backgroundColor: 'transparent'
        }}
      />
    </div>
  );
}