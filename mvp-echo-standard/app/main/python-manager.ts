import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app } from 'electron';
import { spawn } from 'child_process';
import * as crypto from 'crypto';

interface PythonSession {
  sessionId: string;
  tempDir: string;
  pythonPath: string;
  isExtracted: boolean;
  createdAt: Date;
}

export class PythonManager {
  private session: PythonSession | null = null;
  private isPortable: boolean = false;
  private extractionPromise: Promise<void> | null = null;
  private cleanupScheduled: boolean = false;

  constructor() {
    this.isPortable = this.checkIfPortable();
    this.setupCleanupHandlers();
    this.cleanupOrphanedSessions();
  }

  /**
   * Check if running in portable mode
   */
  private checkIfPortable(): boolean {
    // Check if running from portable exe or if portable flag is set
    const exeName = path.basename(process.execPath);
    const isPortableExe = exeName.toLowerCase().includes('portable');
    const isPortableEnv = process.env.MVP_ECHO_PORTABLE === 'true';
    const isDevPortable = process.env.NODE_ENV === 'development' && process.env.PORTABLE_MODE === 'true';
    
    return isPortableExe || isPortableEnv || isDevPortable;
  }

  /**
   * Get or create Python environment
   */
  async getPythonEnvironment(): Promise<string> {
    if (!this.isPortable) {
      // Use system Python
      return await this.findSystemPython();
    }

    if (this.session && this.session.isExtracted) {
      return this.session.pythonPath;
    }

    // Extract Python if not already done
    if (!this.extractionPromise) {
      this.extractionPromise = this.extractPython();
    }

    await this.extractionPromise;
    return this.session!.pythonPath;
  }

  /**
   * Find system Python installation
   */
  private async findSystemPython(): Promise<string> {
    const pythonCommands = ['python', 'python3', 'py'];
    
    for (const cmd of pythonCommands) {
      try {
        await new Promise((resolve, reject) => {
          const testProcess = spawn(cmd, ['--version'], { stdio: 'ignore' });
          testProcess.on('close', (code) => {
            if (code === 0) resolve(undefined);
            else reject();
          });
          testProcess.on('error', reject);
        });
        return cmd;
      } catch {
        continue;
      }
    }
    
    throw new Error('Python not found. Please install Python 3.7+ or use portable version.');
  }

  /**
   * Extract Python to temporary directory
   */
  private async extractPython(): Promise<void> {
    console.log('🎁 Extracting portable Python environment...');
    
    // Generate unique session ID
    const sessionId = crypto.randomBytes(8).toString('hex');
    const tempDir = path.join(os.tmpdir(), `mvp-echo-python-${sessionId}`);
    
    // Create temp directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    this.session = {
      sessionId,
      tempDir,
      pythonPath: '',
      isExtracted: false,
      createdAt: new Date()
    };

    try {
      // Get Python bundle path
      const bundlePath = this.getPythonBundlePath();
      
      if (!fs.existsSync(bundlePath)) {
        throw new Error(`Python bundle not found at: ${bundlePath}`);
      }

      // Check if it's a compressed bundle or directory
      if (bundlePath.endsWith('.7z') || bundlePath.endsWith('.zip')) {
        await this.extractCompressedBundle(bundlePath, tempDir);
      } else {
        // Copy directory structure
        await this.copyDirectory(bundlePath, path.join(tempDir, 'python'));
        
        // Copy Whisper models if they exist
        const modelsSourceDir = path.join(bundlePath, 'models');
        const modelsTargetDir = path.join(tempDir, 'python', 'models');
        
        if (fs.existsSync(modelsSourceDir)) {
          console.log('📦 Copying Whisper models for offline use...');
          await this.copyDirectory(modelsSourceDir, modelsTargetDir);
          console.log('✅ Whisper models copied for offline transcription');
        }
      }

      // Set Python executable path
      const pythonExe = path.join(tempDir, 'python', 'python.exe');
      if (!fs.existsSync(pythonExe)) {
        throw new Error(`Python executable not found at: ${pythonExe}`);
      }

      this.session.pythonPath = pythonExe;
      this.session.isExtracted = true;

      // Set environment variables for embedded Python
      process.env.PYTHONHOME = path.join(tempDir, 'python');
      process.env.PYTHONPATH = path.join(tempDir, 'python', 'Lib');
      
      console.log(`✅ Python extracted to: ${tempDir}`);
      console.log(`🐍 Python executable: ${pythonExe}`);
      
    } catch (error) {
      console.error('❌ Failed to extract Python:', error);
      // Clean up on failure
      if (fs.existsSync(tempDir)) {
        await this.removeDirectory(tempDir);
      }
      this.session = null;
      throw error;
    }
  }

  /**
   * Get Python bundle path
   */
  private getPythonBundlePath(): string {
    const possiblePaths = [
      // In development
      path.join(__dirname, '../../python-embedded'),
      path.join(__dirname, '../../python-embedded.7z'),
      
      // In production (resources)
      path.join(process.resourcesPath, 'python-embedded'),
      path.join(process.resourcesPath, 'python-embedded.7z'),
      
      // In app.asar.unpacked
      path.join(process.resourcesPath, 'app.asar.unpacked', 'python-embedded'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'python-embedded.7z'),
    ];

    for (const bundlePath of possiblePaths) {
      if (fs.existsSync(bundlePath)) {
        console.log(`📦 Found Python bundle at: ${bundlePath}`);
        return bundlePath;
      }
    }

    throw new Error('Python bundle not found in any expected location');
  }

  /**
   * Extract compressed bundle (7z or zip)
   */
  private async extractCompressedBundle(bundlePath: string, targetDir: string): Promise<void> {
    console.log(`📦 Extracting compressed bundle: ${bundlePath}`);
    
    // Try to use 7z executable if available
    const sevenZipPath = this.find7ZipExecutable();
    
    if (sevenZipPath && bundlePath.endsWith('.7z')) {
      // Use 7z for extraction
      await new Promise((resolve, reject) => {
        const extractProcess = spawn(sevenZipPath, [
          'x', bundlePath,
          `-o${targetDir}`,
          '-y' // Assume yes to all queries
        ]);

        extractProcess.on('close', (code) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(`7z extraction failed with code ${code}`));
        });

        extractProcess.on('error', reject);
      });
    } else {
      // Fallback to Node.js extraction (requires additional package)
      // For now, we'll require uncompressed bundle in development
      throw new Error('Compressed Python bundle extraction requires 7z. Please provide uncompressed python-embedded folder.');
    }
  }

  /**
   * Find 7-Zip executable
   */
  private find7ZipExecutable(): string | null {
    const possiblePaths = [
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
      path.join(process.resourcesPath, '7z.exe'),
    ];

    for (const exePath of possiblePaths) {
      if (fs.existsSync(exePath)) {
        return exePath;
      }
    }

    // Try system PATH
    try {
      const result = spawn('7z', ['--help'], { stdio: 'ignore' });
      if (result) return '7z';
    } catch {
      // Not in PATH
    }

    return null;
  }

  /**
   * Copy directory recursively
   */
  private async copyDirectory(source: string, target: string): Promise<void> {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const entries = fs.readdirSync(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  /**
   * Setup cleanup handlers
   */
  private setupCleanupHandlers(): void {
    // Clean up on app quit
    app.on('before-quit', async (event) => {
      if (!this.cleanupScheduled && this.session) {
        event.preventDefault();
        this.cleanupScheduled = true;
        await this.cleanup();
        app.quit();
      }
    });

    // Clean up on window close
    app.on('window-all-closed', async () => {
      await this.cleanup();
    });

    // Clean up on process exit
    process.on('exit', () => {
      this.cleanupSync();
    });

    // Clean up on uncaught exception
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      this.cleanupSync();
    });

    // Clean up on unhandled rejection
    process.on('unhandledRejection', (error) => {
      console.error('Unhandled rejection:', error);
      this.cleanupSync();
    });
  }

  /**
   * Clean up Python environment
   */
  async cleanup(): Promise<void> {
    if (!this.session) return;

    console.log('🧹 Cleaning up Python environment...');
    
    try {
      const tempDir = this.session.tempDir;
      
      if (fs.existsSync(tempDir)) {
        await this.removeDirectory(tempDir);
        console.log(`✅ Cleaned up temp directory: ${tempDir}`);
      }
      
      this.session = null;
    } catch (error) {
      console.error('❌ Error during cleanup:', error);
    }
  }

  /**
   * Synchronous cleanup (for emergency exit)
   */
  private cleanupSync(): void {
    if (!this.session) return;

    try {
      const tempDir = this.session.tempDir;
      
      if (fs.existsSync(tempDir)) {
        this.removeDirectorySync(tempDir);
      }
    } catch (error) {
      console.error('Error during sync cleanup:', error);
    }
  }

  /**
   * Remove directory recursively
   */
  private async removeDirectory(dirPath: string): Promise<void> {
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        await this.removeDirectory(fullPath);
      } else {
        // Try to remove file, retry if locked
        let retries = 3;
        while (retries > 0) {
          try {
            fs.unlinkSync(fullPath);
            break;
          } catch (error: any) {
            if (error.code === 'EBUSY' || error.code === 'EPERM') {
              retries--;
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              throw error;
            }
          }
        }
      }
    }

    fs.rmdirSync(dirPath);
  }

  /**
   * Remove directory recursively (sync version)
   */
  private removeDirectorySync(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        this.removeDirectorySync(fullPath);
      } else {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // Ignore errors in sync cleanup
        }
      }
    }

    try {
      fs.rmdirSync(dirPath);
    } catch {
      // Ignore errors in sync cleanup
    }
  }

  /**
   * Clean up orphaned sessions from previous runs
   */
  private async cleanupOrphanedSessions(): Promise<void> {
    try {
      const tempDir = os.tmpdir();
      const entries = fs.readdirSync(tempDir);
      
      for (const entry of entries) {
        if (entry.startsWith('mvp-echo-python-')) {
          const fullPath = path.join(tempDir, entry);
          const stats = fs.statSync(fullPath);
          
          // Remove directories older than 24 hours
          const ageMs = Date.now() - stats.mtime.getTime();
          if (ageMs > 24 * 60 * 60 * 1000) {
            console.log(`🧹 Removing orphaned Python session: ${entry}`);
            await this.removeDirectory(fullPath);
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning orphaned sessions:', error);
    }
  }

  /**
   * Get session info
   */
  getSessionInfo(): any {
    if (!this.session) {
      return {
        active: false,
        portable: this.isPortable
      };
    }

    return {
      active: true,
      portable: this.isPortable,
      sessionId: this.session.sessionId,
      tempDir: this.session.tempDir,
      pythonPath: this.session.pythonPath,
      createdAt: this.session.createdAt,
      uptime: Date.now() - this.session.createdAt.getTime()
    };
  }
}

// Export singleton instance
export const pythonManager = new PythonManager();