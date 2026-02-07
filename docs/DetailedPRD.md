# MVP-Echo - Product Requirements Document (PRD)

## Executive Summary

MVP-Echo is a Windows 11 desktop application for real-time voice-to-text transcription using Whisper models via ONNX Runtime. The app leverages GPU acceleration (DirectML) with CPU fallback, providing professional-quality transcription with a modern, responsive interface.

## Product Vision

**Create the most responsive, beautiful, and reliable voice transcription app for Windows 11 users who frequently minimize/restore applications.**

## Core Value Propositions

1. **GPU-Accelerated Performance**: Real-time transcription with DirectML
2. **Offline-First**: No internet required after initial setup
3. **Minimal & Beautiful**: MVP Scale design optimized for frequent minimization
4. **Zero Telemetry**: Privacy-focused with minimal logging
5. **Single-Click Install**: Sub-120MB installer with portable option

## Target Users

- **Primary**: Windows 11 professionals who need accurate transcription
- **Secondary**: Content creators, journalists, researchers
- **Use Case**: Users who minimize/restore apps frequently while multitasking

---

## 📊 Current Development Status

### ✅ **COMPLETED - Infrastructure & UI**
- Windows 11 native development environment 
- Electron + React + TypeScript architecture
- MVP Scale design system implementation
- Modern Windows 11 styling with clean edges
- Real audio capture from microphone (MediaRecorder API)
- Complete audio processing pipeline  
- IPC communication between main/renderer processes
- Beautiful responsive UI with recording controls
- Audio visualizer with real-time animation
- System info detection and display

### 🔴 **BLOCKING ISSUE - Speech-to-Text Engine**
**PROBLEM**: ONNX Runtime backend initialization failing
- DirectML execution provider not found
- CPUExecutionProvider backend missing
- Currently using mock transcription (random responses)

**IMPACT**: Core functionality not working - **user speech not transcribed**

### 🎯 **IMMEDIATE GOAL**
**Achieve MVP Success Criteria**: When user says "Hello" → App shows "Hello"

---

## User Stories & Acceptance Criteria

### Epic 1: Core Recording & Transcription

#### US1.1: Basic Voice Recording
**As a user, I want to start/stop voice recording with a single click**
- **AC1**: Large, accessible Record button visible when minimized ✅ **COMPLETED**
- **AC2**: Recording starts within 200ms of button press ✅ **COMPLETED**
- **AC3**: Visual recording indicator (pulse animation) ✅ **COMPLETED**
- **AC4**: Audio level visualization during recording ✅ **COMPLETED**
- **AC5**: Keyboard shortcut (Space) to start/stop ❌ **NOT IMPLEMENTED**
- **✅ STATUS**: FUNCTIONAL - Real audio capture and UI working

#### US1.2: Real-Time Transcription 🎯 **MVP SUCCESS CRITERIA**
**As a user, I want to see live transcription while recording**

**🎯 DEFINITION OF SUCCESS FOR MVP TESTING:**
**When user speaks "Hello, this is a test" → Application displays "Hello, this is a test"**

- **AC1**: Text appears during recording (< 1s latency on GPU)
- **AC2**: Partial results shown with visual distinction  
- **AC3**: Auto-scroll to latest transcribed text
- **AC4**: Text remains readable when window is minimized
- **AC5**: Transcription accuracy matches Python Whisper baseline
- **🔴 STATUS**: NOT COMPLETED - Mock transcription only, no real speech-to-text

#### US1.3: Export Functionality
**As a user, I want to export transcripts in multiple formats**
- **AC1**: Export to TXT format
- **AC2**: Export to Markdown format
- **AC3**: Copy to clipboard functionality
- **AC4**: File chooser remembers last directory
- **AC5**: Export disabled when no text available

### Epic 2: Model Management

#### US2.1: First-Run Model Setup
**As a user, I want to select and download models on first launch**
- **AC1**: Model selection dialog (tiny, base, small)
- **AC2**: Download progress with resume capability
- **AC3**: SHA256 verification for model integrity
- **AC4**: Option to skip for offline usage
- **AC5**: Clear storage location information

#### US2.2: Model Switching
**As a user, I want to change models for different accuracy/speed needs**
- **AC1**: Model selection in Settings panel
- **AC2**: Model switching without app restart
- **AC3**: Performance indicators for each model
- **AC4**: Disk space usage display
- **AC5**: Model deletion option

### Epic 3: System Integration

#### US3.1: GPU Detection & Fallback
**As a user, I want automatic GPU detection with CPU fallback**
- **AC1**: Detect DirectML-compatible GPUs (NVIDIA, AMD, Intel)
- **AC2**: Graceful fallback to CPU when GPU unavailable
- **AC3**: Current engine displayed in Settings/Status
- **AC4**: No crashes during GPU driver failures
- **AC5**: Performance expectations communicated to user

#### US3.2: Windows 11 Integration
**As a user, I want native Windows 11 experience**
- **AC1**: Theme follows system preference (light/dark)
- **AC2**: Start menu shortcuts created
- **AC3**: Proper window management (minimize/restore)
- **AC4**: High DPI display support
- **AC5**: Windows 11 Fluent Design principles

### Epic 4: Installation & Updates

#### US4.1: Easy Installation
**As a user, I want simple, trusted installation**
- **AC1**: Single installer exe under 120MB
- **AC2**: Install completes in under 30 seconds
- **AC3**: Optional portable exe version
- **AC4**: No antivirus false positives
- **AC5**: Clean uninstall removes all files

---

## Technical Requirements

### Performance Targets
| Metric | GPU Target | CPU Target |
|--------|------------|------------|
| Startup Time | < 3 seconds | < 5 seconds |
| Model Load Time | < 2 seconds | < 3 seconds |
| Real-time Factor | < 0.3 | < 1.0 |
| Memory Usage | < 500MB peak | < 300MB peak |
| Recording Latency | < 200ms | < 200ms |

### System Requirements
- **OS**: Windows 11 version 22H2+
- **RAM**: 4GB minimum, 8GB recommended
- **Storage**: 500MB for app, 1-5GB for models
- **GPU**: DirectML-compatible (optional)
- **Audio**: Any Windows-compatible microphone

### Security & Privacy
- No telemetry without explicit opt-in
- Minimal logging (errors only)
- Local processing only (no cloud)
- Models stored locally in `%LOCALAPPDATA%`
- No sensitive data in logs or commits

---

## Agent Task Mapping

### Lead_Architect Tasks
**Priority: Critical - Foundation for all other work**

1. **Architecture RFC** (2 days)
   - Component diagram with data flow
   - IPC communication patterns
   - Model cache policy
   - Dependency allowlist

2. **Project Structure** (1 day)
   - Create folder hierarchy
   - Set up build configuration
   - Define interface contracts

3. **Technical Decisions** (1 day)
   - Finalize electron-builder config
   - Model storage strategy
   - Update mechanism choice

### STT_Engineer Tasks
**Priority: Critical - Core functionality**

1. **ONNX Runtime Integration** (3 days)
   - `stt/session.ts` with GPU/CPU providers
   - Model loading and session management
   - Error handling and cleanup

2. **Audio Processing** (2 days)
   - `audio/recorder.ts` for MediaRecorder integration
   - `audio/wav.ts` for format conversion
   - Real-time audio level detection

3. **GPU Health Check** (2 days)
   - `stt/health.ts` for provider detection
   - Performance benchmarking
   - Fallback mechanisms

4. **Transcription Pipeline** (3 days)
   - `stt/pipeline.ts` for streaming inference
   - Context management between chunks
   - Partial result handling

### UI_Designer Tasks
**Priority: High - User experience**

1. **Core Components** (4 days)
   - Recording controls with MVP Scale styling
   - Real-time transcription display
   - Audio visualizer with pulse animation
   - Settings panel with theme support

2. **Responsive Design** (2 days)
   - Minimization optimization
   - Mobile/narrow screen support
   - Keyboard navigation

3. **First-Run Experience** (2 days)
   - Model selection dialog
   - Download progress with resume
   - Onboarding flow

4. **Error States & Loading** (1 day)
   - Skeleton loading states
   - Error message design
   - Empty states

### Windows_Packager Tasks
**Priority: High - Distribution**

1. **Build Configuration** (2 days)
   - `electron-builder.yml` complete setup
   - NSIS installer customization
   - Portable exe configuration

2. **Build Scripts** (2 days)
   - PowerShell build automation
   - Asset optimization
   - Code signing integration

3. **Distribution** (1 day)
   - Artifact naming conventions
   - Update feed setup
   - Release process documentation

4. **Testing Environment** (1 day)
   - Fresh Windows 11 VM testing
   - Smoke test checklist
   - Performance validation

### QA_Reviewer Tasks
**Priority: Medium - Quality assurance**

1. **Test Strategy** (2 days)
   - Unit test plan for critical paths
   - Integration test scenarios
   - Performance benchmarks

2. **Documentation** (2 days)
   - User guide creation
   - API documentation
   - Release notes template

3. **Quality Gates** (1 day)
   - Code review checklist
   - Bug tracking workflow
   - Acceptance criteria validation

---

## Development Phases

### Phase 1: Foundation (Week 1)
**Goal: Basic app shell with recording capability**

- Lead_Architect: Complete architecture RFC and project structure
- STT_Engineer: Basic ONNX session with GPU detection
- UI_Designer: Main app layout with recording controls
- Windows_Packager: Basic electron-builder setup
- QA_Reviewer: Test plan and acceptance criteria

**Deliverable**: Runnable app that can record audio and show basic transcription

### Phase 2: Core Features (Week 2)
**Goal: Complete transcription pipeline with model management**

- STT_Engineer: Complete audio pipeline and streaming inference
- UI_Designer: Transcription display and export functionality
- Windows_Packager: Model download and caching system
- QA_Reviewer: Core feature testing

**Deliverable**: Fully functional transcription with export capabilities

### Phase 3: Polish & Package (Week 3)
**Goal: Production-ready installer with full Windows 11 integration**

- UI_Designer: Responsive design optimization and first-run experience
- Windows_Packager: Complete installer with code signing
- QA_Reviewer: Full testing cycle and documentation
- All: Bug fixes and performance optimization

**Deliverable**: Production installer ready for distribution

---

## Success Metrics

### Technical Success
- [ ] App starts in < 3 seconds
- [ ] Recording latency < 200ms
- [ ] GPU acceleration works on 90% of target hardware
- [ ] Installer size < 120MB
- [ ] Zero critical bugs in release candidate

### User Experience Success
- [ ] Intuitive for Windows 11 users
- [ ] Beautiful when minimized
- [ ] Keyboard shortcuts work seamlessly
- [ ] Theme matches system preference
- [ ] No user-reported crashes

### Business Success
- [ ] Clean installation on fresh Windows 11 VMs
- [ ] No antivirus false positives
- [ ] Positive user feedback on design
- [ ] Performance matches expectations
- [ ] Successful offline operation

---

## Risk Mitigation

### Technical Risks
- **ONNX Runtime GPU Issues**: Early GPU testing across hardware
- **Model Size/Performance**: Benchmark all model sizes early
- **Electron Bundle Size**: Regular size monitoring and optimization

### User Experience Risks
- **Minimization UX**: Prototype early with real usage patterns
- **First-Run Complexity**: Simple, skippable onboarding flow
- **Performance Expectations**: Clear communication about GPU vs CPU

### Distribution Risks
- **Code Signing**: Set up certificates and signing process early
- **Antivirus Detection**: Test with major antivirus software
- **Update Mechanism**: Simple, reliable update strategy

---

## Out of Scope (V1)

- Multiple language support
- Cloud synchronization
- Advanced audio processing (noise reduction, etc.)
- Plugin system or API
- Mobile applications
- Web interface
- Advanced transcription editing
- Speaker identification
- Batch processing of audio files

---

This PRD provides a clear, maintainable roadmap that aligns with your multi-agent approach while keeping scope focused on delivering a high-quality Windows 11 Whisper application.