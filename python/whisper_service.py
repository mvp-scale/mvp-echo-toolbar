#!/usr/bin/env python3
"""
MVP-Echo Whisper Service
Simple Python sidecar for reliable speech-to-text using OpenAI Whisper
"""

import sys
import json
import traceback
import tempfile
import os
from pathlib import Path

def log(message):
    """Log to stderr so it doesn't interfere with JSON output"""
    print(f"[Python] {message}", file=sys.stderr, flush=True)

def install_whisper():
    """Install faster-whisper if not available"""
    try:
        from faster_whisper import WhisperModel
        return WhisperModel
    except ImportError:
        log("faster-whisper not found, installing...")
        import subprocess
        
        # Try to install faster-whisper
        try:
            # Redirect pip output to stderr to avoid interfering with JSON protocol
            subprocess.check_call([sys.executable, "-m", "pip", "install", "faster-whisper"], 
                                stdout=sys.stderr, stderr=sys.stderr)
            from faster_whisper import WhisperModel
            log("✅ faster-whisper installed successfully")
            return WhisperModel
        except Exception as e:
            log(f"❌ Failed to install faster-whisper: {e}")
            return None

def get_offline_model_path(model_size="tiny"):
    """Get path to offline Whisper model if available"""
    # Check for models in the same directory as this script
    script_dir = Path(__file__).parent
    models_dir = script_dir / "models"
    
    if models_dir.exists():
        model_file = models_dir / f"{model_size}.pt"
        if model_file.exists():
            log(f"Found offline model: {model_file}")
            return str(model_file)
    
    log(f"Offline model not found for {model_size}, will download")
    return model_size  # Fallback to download

def list_available_models():
    """List all available offline Whisper models"""
    script_dir = Path(__file__).parent
    models_dir = script_dir / "models"
    
    available_models = []
    
    if models_dir.exists():
        # Check for manifest file
        manifest_file = models_dir / "manifest.json"
        if manifest_file.exists():
            try:
                import json
                with open(manifest_file, 'r') as f:
                    manifest = json.load(f)
                    available_models = manifest.get('models', [])
                    log(f"Found model manifest with {len(available_models)} models")
            except Exception as e:
                log(f"Failed to read manifest: {e}")
        
        # Fallback: scan for .pt files
        if not available_models:
            for model_file in models_dir.glob("*.pt"):
                model_name = model_file.stem
                available_models.append({
                    "name": model_name,
                    "file": model_file.name,
                    "description": f"Offline {model_name} model"
                })
    
    if not available_models:
        # Default available models (will be downloaded)
        available_models = [
            {"name": "tiny", "description": "Fastest, basic accuracy (downloads ~39MB)"},
            {"name": "base", "description": "Good balance (downloads ~74MB)"},
            {"name": "small", "description": "Better accuracy (downloads ~244MB)"}
        ]
    
    return available_models

def transcribe_audio(audio_data, model_size="tiny"):
    """Transcribe audio data using faster-whisper"""
    try:
        WhisperModel = install_whisper()
        if not WhisperModel:
            return {"error": "Failed to load faster-whisper"}
        
        # Try to use offline model first
        model_path = get_offline_model_path(model_size)
        log(f"Loading faster-whisper model: {model_size} from {model_path}")
        
        # Use CPU for MVP, can be changed to "cuda" for GPU acceleration
        model = WhisperModel(model_path, device="cpu", compute_type="int8")
        
        # Save audio data to temp file
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_file:
            # Write raw audio data (assuming WAV format from Electron)
            temp_file.write(bytes(audio_data))
            temp_path = temp_file.name
        
        try:
            log(f"Transcribing audio file: {temp_path}")
            segments, info = model.transcribe(temp_path)
            
            # Collect all segments into full text
            full_text = ""
            segment_count = 0
            for segment in segments:
                full_text += segment.text
                segment_count += 1
            
            full_text = full_text.strip()
            log(f"✅ Transcription successful: '{full_text[:50]}...'")
            
            return {
                "success": True,
                "text": full_text,
                "language": info.language,
                "language_probability": info.language_probability,
                "segments": segment_count,
                "model": model_size,
                "duration": info.duration
            }
            
        finally:
            # Clean up temp file
            try:
                os.unlink(temp_path)
            except:
                pass
                
    except Exception as e:
        log(f"❌ Transcription error: {e}")
        log(traceback.format_exc())
        return {"error": str(e)}

def transcribe_audio_file(audio_file_path, model_size="tiny"):
    """Transcribe audio from file path using faster-whisper"""
    try:
        WhisperModel = install_whisper()
        if not WhisperModel:
            return {"error": "Failed to load faster-whisper"}
        
        # Try to use offline model first
        model_path = get_offline_model_path(model_size)
        log(f"Loading faster-whisper model: {model_size} from {model_path}")
        
        # Use CPU for MVP, can be changed to "cuda" for GPU acceleration
        model = WhisperModel(model_path, device="cpu", compute_type="int8")
        
        if not os.path.exists(audio_file_path):
            return {"error": f"Audio file not found: {audio_file_path}"}
        
        # Debug: Check file size and basic info
        import wave
        try:
            with wave.open(audio_file_path, 'rb') as wav_file:
                frames = wav_file.getnframes()
                sample_rate = wav_file.getframerate()
                channels = wav_file.getnchannels()
                duration = frames / sample_rate
                log(f"WAV file info: {frames} frames, {sample_rate}Hz, {channels} channels, {duration:.2f}s")
        except Exception as wav_error:
            log(f"Warning: Could not read WAV file info: {wav_error}")
        
        log(f"Transcribing audio file: {audio_file_path}")
        segments, info = model.transcribe(audio_file_path, 
                                        beam_size=1,  # Faster but less accurate for debugging
                                        vad_filter=False,  # Disable voice activity detection
                                        word_timestamps=False)
        
        # Collect all segments into full text
        full_text = ""
        segment_count = 0
        for segment in segments:
            full_text += segment.text
            segment_count += 1
        
        full_text = full_text.strip()
        log(f"✅ Transcription successful: '{full_text[:50]}...'")
        
        return {
            "success": True,
            "text": full_text,
            "language": info.language,
            "language_probability": info.language_probability,
            "segments": segment_count,
            "model": model_size,
            "duration": info.duration
        }
        
    except Exception as e:
        log(f"❌ File transcription error: {e}")
        log(traceback.format_exc())
        return {"error": str(e)}

def main():
    """Main service loop - read JSON requests from stdin, output JSON responses"""
    log("🎤 MVP-Echo Whisper Service starting...")
    log("Python version: " + sys.version)
    
    try:
        # Test whisper availability
        whisper = install_whisper()
        if whisper:
            log("✅ Whisper available")
            # List available models (offline and online)
            available_models = list_available_models()
            offline_count = sum(1 for m in available_models if 'offline' in m.get('description', '').lower() or not 'download' in m.get('description', ''))
            log(f"Available models: {len(available_models)} total ({offline_count} offline)")
            for model in available_models:
                log(f"  - {model['name']}: {model['description']}")
        else:
            log("❌ Whisper not available")
            return
            
        log("Ready for transcription requests...")
        
        # Process requests from stdin
        for line in sys.stdin:
            try:
                request = json.loads(line.strip())
                
                if request.get("action") == "transcribe":
                    audio_data = request.get("audio_data", [])
                    model_size = request.get("model", "tiny")
                    
                    log(f"Processing transcription request: {len(audio_data)} bytes, model: {model_size}")
                    
                    result = transcribe_audio(audio_data, model_size)
                    
                    # Output JSON response
                    print(json.dumps(result), flush=True)
                    
                elif request.get("action") == "transcribe_file":
                    audio_file = request.get("audio_file", "")
                    model_size = request.get("model", "tiny")
                    
                    log(f"Processing transcription from file: {audio_file}, model: {model_size}")
                    
                    result = transcribe_audio_file(audio_file, model_size)
                    
                    # Output JSON response
                    print(json.dumps(result), flush=True)
                    
                elif request.get("action") == "ping":
                    print(json.dumps({"pong": True}), flush=True)
                    
                elif request.get("action") == "list_models":
                    models = list_available_models()
                    print(json.dumps({"models": models}), flush=True)
                    
                else:
                    print(json.dumps({"error": f"Unknown action: {request.get('action')}"}), flush=True)
                    
            except json.JSONDecodeError as e:
                log(f"❌ Invalid JSON: {e}")
                print(json.dumps({"error": "Invalid JSON request"}), flush=True)
            except Exception as e:
                log(f"❌ Request processing error: {e}")
                print(json.dumps({"error": str(e)}), flush=True)
                
    except KeyboardInterrupt:
        log("Service interrupted")
    except Exception as e:
        log(f"❌ Service error: {e}")
        log(traceback.format_exc())

if __name__ == "__main__":
    main()