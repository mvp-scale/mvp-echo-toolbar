#!/usr/bin/env python3
"""
MVP-Echo Standalone Whisper CLI
Built with PyInstaller for native execution without Python dependencies
Uses Faster-Whisper (CTranslate2) for high performance transcription
"""

import sys
import os
import argparse
import json
import time
from pathlib import Path

try:
    from faster_whisper import WhisperModel
    import torch
except ImportError as e:
    print(f"Error: Required dependencies not found: {e}")
    print("Please install: pip install faster-whisper torch")
    sys.exit(1)

def check_gpu():
    """Check if CUDA GPU is available"""
    try:
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            return True, gpu_name
    except:
        pass
    return False, None

def transcribe_audio(audio_path, model_name="tiny", language="auto", device="auto"):
    """Transcribe audio file using Faster-Whisper"""
    
    # Determine device
    if device == "auto":
        gpu_available, gpu_name = check_gpu()
        device = "cuda" if gpu_available else "cpu"
        compute_type = "float16" if gpu_available else "int8"
    else:
        compute_type = "float16" if device == "cuda" else "int8"
    
    print(f"🎯 Initializing Faster-Whisper...")
    print(f"   Model: {model_name}")
    print(f"   Device: {device}")
    if device == "cuda":
        gpu_available, gpu_name = check_gpu()
        print(f"   GPU: {gpu_name}")
    
    start_time = time.time()
    
    # Initialize model
    try:
        model = WhisperModel(
            model_name, 
            device=device, 
            compute_type=compute_type,
            download_root="./models"  # Store models locally
        )
        print(f"✅ Model loaded in {time.time() - start_time:.1f}s")
    except Exception as e:
        print(f"❌ Model loading failed: {e}")
        return None
    
    # Transcribe
    print(f"🎤 Transcribing: {audio_path}")
    transcribe_start = time.time()
    
    try:
        segments, info = model.transcribe(
            audio_path,
            language=None if language == "auto" else language,
            beam_size=1,  # Faster inference
            best_of=1,    # Faster inference
            temperature=0.0,
            condition_on_previous_text=False,
            vad_filter=True,  # Voice activity detection
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        
        # Extract text
        text_segments = []
        for segment in segments:
            text_segments.append(segment.text)
        
        full_text = " ".join(text_segments).strip()
        processing_time = time.time() - transcribe_start
        
        result = {
            "text": full_text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "processing_time": processing_time,
            "device": device,
            "model": model_name,
            "engine": "MVP-Echo Standalone Faster-Whisper"
        }
        
        print(f"✅ Transcription completed in {processing_time:.1f}s")
        print(f"   Language: {info.language} ({info.language_probability:.2f})")
        print(f"   Duration: {info.duration:.1f}s")
        
        return result
        
    except Exception as e:
        print(f"❌ Transcription failed: {e}")
        return None

def main():
    parser = argparse.ArgumentParser(
        description="MVP-Echo Standalone Whisper - Native speech-to-text transcription",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  whisper-standalone.exe audio.wav
  whisper-standalone.exe audio.mp3 --model base --language en
  whisper-standalone.exe audio.wav --gpu --output-json result.json
        """
    )
    
    parser.add_argument("audio", help="Audio file to transcribe")
    parser.add_argument("-m", "--model", default="tiny", 
                       choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
                       help="Whisper model size (default: tiny)")
    parser.add_argument("-l", "--language", default="auto",
                       help="Audio language (auto-detect if not specified)")
    parser.add_argument("--gpu", action="store_true", 
                       help="Force GPU usage (auto-detect if not specified)")
    parser.add_argument("--cpu", action="store_true",
                       help="Force CPU usage")
    parser.add_argument("--output-json", help="Save detailed results to JSON file")
    parser.add_argument("--quiet", "-q", action="store_true",
                       help="Suppress progress messages")
    parser.add_argument("--version", action="version", version="MVP-Echo Standalone Whisper v1.0")
    
    args = parser.parse_args()
    
    # Validate audio file
    if not os.path.exists(args.audio):
        print(f"❌ Audio file not found: {args.audio}")
        sys.exit(1)
    
    # Determine device
    device = "auto"
    if args.gpu and args.cpu:
        print("❌ Cannot specify both --gpu and --cpu")
        sys.exit(1)
    elif args.gpu:
        device = "cuda"
    elif args.cpu:
        device = "cpu"
    
    # Suppress output if quiet
    if args.quiet:
        sys.stdout = open(os.devnull, 'w')
    
    # Transcribe
    result = transcribe_audio(
        args.audio,
        model_name=args.model,
        language=args.language,
        device=device
    )
    
    # Restore stdout
    if args.quiet:
        sys.stdout = sys.__stdout__
    
    if result is None:
        sys.exit(1)
    
    # Output results
    print(result["text"])
    
    # Save JSON if requested
    if args.output_json:
        with open(args.output_json, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        if not args.quiet:
            print(f"\n📄 Detailed results saved to: {args.output_json}")

if __name__ == "__main__":
    main()