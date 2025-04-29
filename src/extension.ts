import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'glob';
import * as minimatch from 'minimatch';
import ignore from 'ignore';

// Profile structure
interface Profile {
  name: string;
  parent?: string[];
  files: string[];
  excluded: string[];
  workspacePath: string; // Add workspace path to track where each profile comes from
}

// Global state
let currentProfiles: string[] = []; // Change from single profile to array of profiles
let profiles: Map<string, Profile> = new Map();

// Track which workspace folders have been loaded
let loadedWorkspaceFolders: Set<string> = new Set();

// Add file watchers collection
let fileWatchers: vscode.FileSystemWatcher[] = [];

// Extension context for state persistence
let extensionContext: vscode.ExtensionContext;

// File decoration provider
let fileDecorationProvider: vscode.Disposable | undefined;

// Set to store files that will be concatenated
let filesToConcatenateSet: Set<string> = new Set();

export function activate(context: vscode.ExtensionContext) {
  // Log activation with more details
  console.log('ConPlug extension activated - version 1.0.0');
  console.log('Workspace folders:', vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 'none');
  
  try {
    // Store extension context
    extensionContext = context;

    // Load saved profiles from global state
    const savedProfiles = context.globalState.get<string[]>('currentProfiles', []);
    if (savedProfiles.length > 0) {
      currentProfiles = savedProfiles;
      console.log('Loaded saved profiles:', savedProfiles);
    }

    // Register commands
    context.subscriptions.push(
      vscode.commands.registerCommand('conplug.showProfiles', showProfiles),
      vscode.commands.registerCommand('conplug.formFile', formFile),
      vscode.commands.registerCommand('conplug.updateFileDecorations', updateFileDecorations)
    );
    console.log('ConPlug: Commands registered successfully');

    // Setup file watchers for all workspace folders
    setupFileWatchers();
    
    // Handle workspace changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(handleWorkspaceChange)
    );

    // Listen for configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        // Check if our extension's configuration changed
        if (event.affectsConfiguration('conplug.fileDecorationSymbol')) {
          // Force refresh the file decorations to reflect the changed symbol
          vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        } else if (event.affectsConfiguration('conplug.includeGitIgnored') || 
                   event.affectsConfiguration('conplug.excludePatterns')) {
          // Refresh file decorations if gitignore or exclude pattern settings change
          updateFileDecorations();
        }
      })
    );

    // Register file decoration provider
    registerFileDecorationProvider(context);

    // Update file decorations if we have active profiles
    if (currentProfiles.length > 0) {
      // Load configurations first
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        for (const folder of workspaceFolders) {
          loadConfig(folder.uri.fsPath);
        }
      }
      
      // Update decorations
      updateFileDecorations();
    }
    
    // Register some test commands to verify extension is working
    context.subscriptions.push(
      vscode.commands.registerCommand('conplug.test', () => {
        const diagnosticInfo = getDiagnosticInfo();
        vscode.window.showInformationMessage('ConPlug: Test command executed successfully');
        
        // Create a new editor with diagnostic information
        vscode.workspace.openTextDocument({ 
          content: diagnosticInfo,
          language: 'markdown'
        }).then(doc => {
          vscode.window.showTextDocument(doc);
        });
      })
    );
    
    console.log('ConPlug extension activation completed successfully');
  } catch (error) {
    console.error('ConPlug activation error:', error);
    vscode.window.showErrorMessage(`ConPlug: Error during activation: ${error}`);
  }
}

// Register file decoration provider to show visual marks on included files
function registerFileDecorationProvider(context: vscode.ExtensionContext) {
  const provider = vscode.window.registerFileDecorationProvider({
    provideFileDecoration(uri) {
      // Convert the URI to a file path
      const filePath = uri.fsPath;
      
      // Check if this file is in our list of files to concatenate
      if (filesToConcatenateSet.has(filePath)) {
        // Get the decoration symbol from configuration
        const config = vscode.workspace.getConfiguration('conplug');
        const symbol = config.get<string>('fileDecorationSymbol', '⚡');
        
        return {
          badge: symbol, // Use the configured symbol
          tooltip: 'Included in ConPlug profile',
          color: new vscode.ThemeColor('conplug.fileDecorationForeground') // Use theme color if defined
        };
      }
      return undefined;
    }
  });
  
  // Store provider to dispose later
  fileDecorationProvider = provider;
  context.subscriptions.push(provider);
}

// Update the file decorations based on current profiles
async function updateFileDecorations() {
  // Clear existing set
  filesToConcatenateSet.clear();
  
  // Get all workspace folders
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  // Ensure configurations are loaded
  let configFound = false;
  for (const folder of workspaceFolders) {
    const hasConfig = loadConfig(folder.uri.fsPath);
    configFound = configFound || hasConfig;
  }

  // If no config found or no profiles loaded, get all files from each workspace
  if (!configFound || profiles.size === 0) {
    // Include all files from each workspace folder
    for (const folder of workspaceFolders) {
      const allWorkspaceFiles = getAllWorkspaceFiles(folder.uri.fsPath);
      allWorkspaceFiles.forEach(file => filesToConcatenateSet.add(file));
    }
  }
  // Otherwise, use the selected profiles
  else if (currentProfiles.length > 0) {
    // Get all files to concatenate from all selected profiles
    for (const profileName of currentProfiles) {
      const profile = profiles.get(profileName);
      if (!profile) {
        continue;
      }
      
      const profileFiles = resolveFiles(profile, profile.workspacePath);
      profileFiles.forEach(file => filesToConcatenateSet.add(file));
    }
  }

  // Force refresh of file decorations
  vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
}

// Function to setup file watchers for all workspace folders
function setupFileWatchers() {
  // Clear existing watchers
  disposeFileWatchers();
  
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return;
  }
  
  // Create watchers for each workspace folder
  for (const folder of workspaceFolders) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '.conplug')
    );
    
    // Watch for any changes to .conplug files
    watcher.onDidChange(() => reloadConfiguration(folder.uri.fsPath));
    watcher.onDidCreate(() => reloadConfiguration(folder.uri.fsPath));
    watcher.onDidDelete(() => reloadConfiguration(folder.uri.fsPath));
    
    // Add to collection and disposables
    fileWatchers.push(watcher);
    extensionContext.subscriptions.push(watcher);
  }
}

// Function to dispose all file watchers
function disposeFileWatchers() {
  for (const watcher of fileWatchers) {
    watcher.dispose();
  }
  fileWatchers = [];
}

// Handle workspace folder changes
function handleWorkspaceChange(e: vscode.WorkspaceFoldersChangeEvent) {
  // Reload configurations and setup watchers
  setupFileWatchers();
  
  // Reset loaded workspaces
  loadedWorkspaceFolders.clear();
  
  // Reload all configurations
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    for (const folder of workspaceFolders) {
      loadConfig(folder.uri.fsPath);
    }
  }

  // Update file decorations
  updateFileDecorations();
}

// Reload configuration when .conplug file changes
function reloadConfiguration(workspacePath: string) {
  // Remove from loaded workspaces to force reload
  loadedWorkspaceFolders.delete(workspacePath);
  
  // Find profiles from this workspace to remove
  const profilesToRemove: string[] = [];
  profiles.forEach((profile, name) => {
    if (profile.workspacePath === workspacePath) {
      profilesToRemove.push(name);
    }
  });
  
  // Remove profiles from this workspace
  profilesToRemove.forEach(name => {
    profiles.delete(name);
  });
  
  // Load updated config
  loadConfig(workspacePath);
  
  // Check if current profiles still exist
  const validProfiles = currentProfiles.filter(profile => profiles.has(profile));
  if (validProfiles.length !== currentProfiles.length) {
    currentProfiles = validProfiles;
    // Save updated profiles
    extensionContext.globalState.update('currentProfiles', currentProfiles);
    
    if (validProfiles.length > 0) {
      vscode.window.showInformationMessage(`ConPlug: Updated to profiles: ${validProfiles.join(', ')}`);
    } else if (currentProfiles.length > 0) {
      vscode.window.showWarningMessage('ConPlug: Previously selected profiles no longer exist');
    }
  }

  // Update file decorations after config reload
  updateFileDecorations();
}

// Show profiles and let user choose one
async function showProfiles() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('ConPlug: No workspace folder found');
    return;
  }

  // Reset profiles and loaded workspaces
  profiles.clear();
  loadedWorkspaceFolders.clear();

  // Load .conplug files from all workspace folders
  let configFound = false;
  for (const folder of workspaceFolders) {
    const hasConfig = loadConfig(folder.uri.fsPath);
    configFound = configFound || hasConfig;
  }

  // Check if we have profiles to show
  const profileNames = Array.from(profiles.keys());
  
  // If no config found or no profiles defined
  if (!configFound || profileNames.length === 0) {
    // Ask for confirmation before using all files in workspace
    const useAllFiles = await vscode.window.showInformationMessage(
      'ConPlug: No .conplug file found or no profiles defined. Use all files in workspace?',
      { modal: true },
      'Yes', 'No'
    );
    
    if (useAllFiles === 'Yes') {
      // Set a special profile name to indicate "all files"
      currentProfiles = ['_ALL_FILES_'];
      extensionContext.globalState.update('currentProfiles', currentProfiles);
      
      vscode.window.showInformationMessage('ConPlug: Using all files in workspace.');
      
      // Update file decorations to include all files
      updateFileDecorations();
    } else {
      vscode.window.showInformationMessage('ConPlug: No profiles selected.');
      currentProfiles = [];
      extensionContext.globalState.update('currentProfiles', []);
    }
    return;
  }

  // Create QuickPickItems with previously selected items pre-selected
  const quickPickItems = profileNames.map(name => ({
    label: name,
    picked: currentProfiles.includes(name) && !currentProfiles.includes('_ALL_FILES_')
  }));

  // Show quickpick with profile names and allow multiple selection
  const selected = await vscode.window.showQuickPick(quickPickItems, {
    placeHolder: 'Select profile(s)',
    canPickMany: true // Enable multiple selection
  });

  if (selected && selected.length > 0) {
    currentProfiles = selected.map(item => item.label); // Get profile names from the QuickPickItems
    const profilesText = currentProfiles.join(', ');
    vscode.window.showInformationMessage(`ConPlug: Selected profiles: ${profilesText}`);
    
    // Save selection to extension context
    extensionContext.globalState.update('currentProfiles', currentProfiles);

    // Update file decorations after profiles selection
    updateFileDecorations();
  } else {
    // Clear selection if user canceled or deselected all profiles
    currentProfiles = [];
    extensionContext.globalState.update('currentProfiles', []);
    
    // Clear file decorations
    filesToConcatenateSet.clear();
    vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    vscode.window.showInformationMessage('ConPlug: Cleared profile selection');
  }
}

// Form concatenated file from current profile(s)
async function formFile() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('ConPlug: No workspace folder found');
    return;
  }

  // Check if current profiles are set
  if (!currentProfiles || currentProfiles.length === 0) {
    vscode.window.showErrorMessage('ConPlug: No profiles selected. Use "Show profiles" command first.');
    return;
  }

  // Get plugin configuration
  const config = vscode.workspace.getConfiguration('conplug');
  const maxContentSize = config.get<number>('maxContentSize', 1048576); // Default 1MB
  const headerPrefix = config.get<string>('headerPrefix', "\n");
  const headerSuffix = config.get<string>('headerSuffix', "\n");
  const autoCopyToClipboard = config.get<boolean>('autoCopyToClipboard', true); // Assuming default is true

  // Get all files to concatenate
  const allFiles = new Set<string>();

  // --- (Keep the existing logic for collecting files based on _ALL_FILES_ or profiles) ---
  if (currentProfiles.includes('_ALL_FILES_')) {
    const continueWithAllFiles = await vscode.window.showInformationMessage(
      `ConPlug: This will process ALL files in the workspace (up to ${Math.round(maxContentSize / 1024 / 1024)}MB limit). Continue?`,
      { modal: true },
      'Yes', 'No'
    );

    if (continueWithAllFiles !== 'Yes') {
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'ConPlug: Collecting files from workspace...',
      cancellable: false
    }, async (progress) => {
      for (const folder of workspaceFolders) {
        const allWorkspaceFiles = getAllWorkspaceFiles(folder.uri.fsPath);
        allWorkspaceFiles.forEach(file => allFiles.add(file));
        progress.report({ message: `Found ${allFiles.size} files...` });
      }
    });
  } else {
    for (const profileName of currentProfiles) {
      const profile = profiles.get(profileName);
      if (!profile) {
        vscode.window.showErrorMessage(`ConPlug: Profile "${profileName}" not found`);
        continue;
      }

      const profileFiles = resolveFiles(profile, profile.workspacePath);
      profileFiles.forEach(file => allFiles.add(file));
    }
  }
  // --- (End of file collection logic) ---

  const filesToConcatenate = Array.from(allFiles);

  if (filesToConcatenate.length === 0) {
    vscode.window.showWarningMessage('ConPlug: No files to concatenate in the selected profiles');
    return;
  }

  // Update the filesToConcatenateSet with the resolved files for decoration
  filesToConcatenateSet.clear();
  filesToConcatenate.forEach(file => filesToConcatenateSet.add(file));
  vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');

  let content = '';
  let currentSize = 0;
  let sizeLimitExceeded = false;
  let largestFileSize = 0;
  let largestFileName = ''; // Store relative path
  let largestFileFullPath = ''; // Store full path if needed

  // Concatenate files with size checking
  for (const file of filesToConcatenate) {
    try {
      const stats = fs.statSync(file);
      const fileSize = stats.size;

      // Find which workspace folder this file belongs to for relative path
      const workspaceFolder = getWorkspaceFolderForFile(file);
      const relativeFilePath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, file)
        : file; // Fallback to full path if workspace not found

      // Track largest file
      if (fileSize > largestFileSize) {
          largestFileSize = fileSize;
          largestFileName = relativeFilePath;
          largestFileFullPath = file; // Store full path just in case
      }

      // Estimate header size (approximation is fine)
      const commentStyle = getCommentStyleForFile(file);
      const ext = path.extname(file).toLowerCase();
      let headerEstimate = `${headerPrefix}${commentStyle} File: ${relativeFilePath}${headerSuffix}\n\n`;
      if (['.html', '.xml', '.svg', '.jsx', '.tsx', '.css', '.scss', '.less'].includes(ext)) {
          // Estimate size for XML/HTML/CSS style comments (slightly different structure)
          headerEstimate = `${headerPrefix}<!-- File: ${relativeFilePath} -->${headerSuffix}\n\n`; // Adjust length based on actual format
      }
      const estimatedChunkSize = fileSize + Buffer.byteLength(headerEstimate, 'utf8'); // Use Buffer.byteLength for accuracy

      // Check if adding this file would exceed the limit
      if (currentSize + estimatedChunkSize > maxContentSize) {
        sizeLimitExceeded = true;
        vscode.window.showWarningMessage(`ConPlug: Maximum content size (${maxContentSize} bytes) exceeded while processing '${relativeFilePath}'. Generating file list instead.`);
        break; // Stop processing files for content
      }

      // Read file content and construct the actual header
      const fileContent = fs.readFileSync(file, 'utf8');
      let fileHeader = '';
      if (['.html', '.xml', '.svg', '.jsx', '.tsx'].includes(ext)) {
        fileHeader = `${headerPrefix}<!-- File: ${relativeFilePath} -->${headerSuffix}`;
      } else if (['.css', '.scss', '.less'].includes(ext)) {
        fileHeader = `${headerPrefix}/* File: ${relativeFilePath} */${headerSuffix}`;
      } else {
        fileHeader = `${headerPrefix}${commentStyle} File: ${relativeFilePath}${headerSuffix}`;
      }

      const chunkToAdd = `${fileHeader}${fileContent}\n\n`;
      content += chunkToAdd;
      currentSize += Buffer.byteLength(chunkToAdd, 'utf8'); // Update actual size

    } catch (err: any) {
      // Check if it's a directory or other non-file issue we can maybe ignore
      if (err.code === 'EISDIR') {
          console.warn(`ConPlug: Skipping directory listed in profile: ${file}`);
      } else {
          vscode.window.showErrorMessage(`ConPlug: Error reading file ${file}: ${err.message}`);
          // Optionally continue to next file or stop? Let's continue for now.
      }
    }
  } // End of file processing loop

  // --- Output Generation ---

  let finalContent = '';
  let finalMessage = '';

  if (sizeLimitExceeded) {
    // Generate file list instead of content
    finalContent = `Maximum content size (${maxContentSize} bytes) exceeded.\n\nList of files that would have been included:\n\n`;
    let totalListedSize = 0;
    for (const file of filesToConcatenate) {
        try {
            const stats = fs.statSync(file);
            const fileSize = stats.size;
            totalListedSize += fileSize;
            const workspaceFolder = getWorkspaceFolderForFile(file);
            const relativeFilePath = workspaceFolder
                ? path.relative(workspaceFolder.uri.fsPath, file)
                : file;
            finalContent += `- ${relativeFilePath} (${fileSize} bytes)\n`;
        } catch (err: any) {
            finalContent += `- ${file} (Error reading size: ${err.message})\n`;
        }
    }
    finalContent += `\nTotal potential size: ${totalListedSize} bytes`;
    finalMessage = `ConPlug: Content size limit exceeded. File list generated.`;
    // Don't copy to clipboard automatically in this case unless configured differently
  } else {
    // Use the concatenated content
    finalContent = content;
    finalMessage = 'ConPlug: Concatenated content generated.';

    // Copy to clipboard if configured
    if (autoCopyToClipboard) {
      await vscode.env.clipboard.writeText(finalContent);
      let clipboardMessage = 'ConPlug: Concatenated content copied to clipboard';
      if (largestFileName) {
          clipboardMessage += `. Largest file: ${largestFileName} (${largestFileSize} bytes)`;
      }
      vscode.window.showInformationMessage(clipboardMessage);
    } else {
        // Still show the largest file info even if not copying
        if (largestFileName) {
            finalMessage += ` Largest file: ${largestFileName} (${largestFileSize} bytes)`;
        }
        vscode.window.showInformationMessage(finalMessage);
    }
  }

  // Show in a new editor
  try {
      const doc = await vscode.workspace.openTextDocument({ content: finalContent, language: sizeLimitExceeded ? 'plaintext' : undefined }); // Use plaintext for the list
      await vscode.window.showTextDocument(doc);
  } catch(error: any) {
      vscode.window.showErrorMessage(`ConPlug: Error opening document: ${error.message}`);
      console.error("ConPlug: Error opening text document:", error);
      // Fallback: Show message if editor fails
      if(!sizeLimitExceeded && !autoCopyToClipboard) {
          vscode.window.showInformationMessage(finalMessage); // Show the message if not copied and editor failed
      }
  }
}

// Helper function to find which workspace folder a file belongs to
function getWorkspaceFolderForFile(filePath: string): vscode.WorkspaceFolder | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return undefined;
  }
  
  // Sort workspace folders by path length (descending) to match most specific first
  const sortedFolders = [...workspaceFolders].sort((a, b) => 
    b.uri.fsPath.length - a.uri.fsPath.length
  );
  
  for (const folder of sortedFolders) {
    if (filePath.startsWith(folder.uri.fsPath)) {
      return folder;
    }
  }
  
  return undefined;
}

// Load .conplug file and parse profiles
function loadConfig(workspacePath: string): boolean {
  // Skip if already loaded
  if (loadedWorkspaceFolders.has(workspacePath)) {
    return true;
  }
  
  const configPath = path.join(workspacePath, '.conplug');
  if (!fs.existsSync(configPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const workspaceProfiles = parseConfig(content, workspacePath);
    
    // Merge profiles
    for (const [name, profile] of workspaceProfiles.entries()) {
      profiles.set(name, profile);
    }
    
    // Mark this workspace as loaded
    loadedWorkspaceFolders.add(workspacePath);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`ConPlug: Error parsing .conplug file in ${workspacePath}: ${err}`);
    return false;
  }
}

// Parse .conplug file content
function parseConfig(content: string, workspacePath: string): Map<string, Profile> {
  const result = new Map<string, Profile>();
  
  // Simple parser for the .conplug format
  const lines = content.split('\n');
  let currentProfile: Profile | null = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines and comments
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    
    // Check for profile definition
    const profileMatch = line.match(/^([^:{}]+)(?::([^{]+))?{/);
    if (profileMatch) {
      // Save previous profile if any
      if (currentProfile) {
        result.set(currentProfile.name, currentProfile);
      }
      
      // Create new profile
      const profileName = profileMatch[1].trim();
      const parents = profileMatch[2] ? 
        profileMatch[2].split(',').map(p => p.trim()) : 
        [];
      
      currentProfile = {
        name: profileName,
        parent: parents.length > 0 ? parents : undefined,
        files: [],
        excluded: [],
        workspacePath // Store workspace path with the profile
      };
      continue;
    }
    
    // Check for profile end
    if (line === '}') {
      if (currentProfile) {
        result.set(currentProfile.name, currentProfile);
        currentProfile = null;
      }
      continue;
    }
    
    // Add file to current profile
    if (currentProfile) {
      if (line.startsWith('!')) {
        currentProfile.excluded.push(line.substring(1).trim());
      } else {
        currentProfile.files.push(line);
      }
    }
  }
  
  // Save last profile if any
  if (currentProfile) {
    result.set(currentProfile.name, currentProfile);
  }
  
  return result;
}

// Resolve files from profile, including inherited profiles
function resolveFiles(profile: Profile, workspacePath: string): string[] {
  const allFiles = new Set<string>();
  const excluded = new Set<string>();
  
  // Add files from parent profiles
  if (profile.parent) {
    for (const parentName of profile.parent) {
      const parent = profiles.get(parentName);
      if (parent) {
        const parentFiles = resolveFiles(parent, parent.workspacePath);
        parentFiles.forEach(file => allFiles.add(file));
      }
    }
  }
  
  // Add excluded files
  profile.excluded.forEach(pattern => {
    const matches = expandGlobPatterns([pattern], workspacePath);
    matches.forEach(file => excluded.add(file));
  });
  
  // Add files from current profile
  const fileMatches = expandGlobPatterns(profile.files, workspacePath);
  fileMatches.forEach(file => {
    if (!excluded.has(file)) {
      allFiles.add(file);
    }
  });
  
  return Array.from(allFiles);
}

// Expand glob patterns to actual file paths
function expandGlobPatterns(patterns: string[], workspacePath: string): string[] {
  const includeGitIgnored = vscode.workspace.getConfiguration('conplug').get<boolean>('includeGitIgnored');
  const allFiles = new Set<string>();
  const gitIgnorePath = path.join(workspacePath, '.gitignore');
  
  // Load .gitignore if exists and setting is enabled
  let ignoreFilter: any = null;
  if (!includeGitIgnored && fs.existsSync(gitIgnorePath)) {
    const gitIgnoreContent = fs.readFileSync(gitIgnorePath, 'utf8');
    ignoreFilter = ignore().add(gitIgnoreContent);
  }
  
  // Process each pattern
  for (const pattern of patterns) {
    // Check if it's a directory pattern ending with /
    if (pattern.endsWith('/')) {
      const dirPath = path.join(workspacePath, pattern);
      const dirGlob = path.join(dirPath, '**/*');
      const matches = glob.sync(dirGlob, { nodir: true });
      
      for (const file of matches) {
        const relativePath = path.relative(workspacePath, file);
        if (!ignoreFilter || !ignoreFilter.ignores(relativePath)) {
          allFiles.add(file);
        }
      }
    } 
    // Check if it's a file pattern
    else {
      const filePath = path.join(workspacePath, pattern);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        // Direct file path
        const relativePath = path.relative(workspacePath, filePath);
        if (!ignoreFilter || !ignoreFilter.ignores(relativePath)) {
          allFiles.add(filePath);
        }
      } else {
        // Glob pattern
        const matches = glob.sync(path.join(workspacePath, pattern));
        for (const file of matches) {
          const relativePath = path.relative(workspacePath, file);
          if (fs.statSync(file).isFile() && (!ignoreFilter || !ignoreFilter.ignores(relativePath))) {
            allFiles.add(file);
          }
        }
      }
    }
  }
  
  return Array.from(allFiles);
}

// Get the appropriate comment style based on file extension
function getCommentStyleForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const config = vscode.workspace.getConfiguration('conplug');
  const commentMap = config.get<Record<string, string>>('languageCommentMap', {
    '.sh': '#',
    '.bash': '#',
    '.zsh': '#',
    '.py': '#',
    '.rb': '#',
    '.pl': '#',
    '.pm': '#',
    '.yml': '#',
    '.yaml': '#',
    '.toml': '#',
    '.conf': '#',
    '.ini': '#',
    '.cfg': '#',
    '.sql': '--',
    '.lua': '--',
    'default': '//'
  });
  
  // Check if we have a specific comment style for this extension
  if (ext in commentMap) {
    return commentMap[ext];
  }
  
  // Return default comment style
  return commentMap['default'] || '//';
}

// Get all files in a workspace folder, respecting gitignore settings
function getAllWorkspaceFiles(workspacePath: string): string[] {
  const allFiles = new Set<string>();
  const config = vscode.workspace.getConfiguration('conplug');
  const includeGitIgnored = config.get<boolean>('includeGitIgnored');
  const excludePatterns = config.get<string[]>('excludePatterns', [
    '**/node_modules/**',
    '**/.git/**',
    '**/out/**',
    '**/dist/**',
    '**/build/**'
  ]);
  
  const gitIgnorePath = path.join(workspacePath, '.gitignore');
  
  // Load .gitignore if exists and setting is enabled
  let ignoreFilter: any = null;
  if (!includeGitIgnored && fs.existsSync(gitIgnorePath)) {
    const gitIgnoreContent = fs.readFileSync(gitIgnorePath, 'utf8');
    ignoreFilter = ignore().add(gitIgnoreContent);
  }

  try {
    // Use "**" pattern to get all files in the workspace
    const globPattern = path.join(workspacePath, '**/*');
    const files = glob.sync(globPattern, { 
      nodir: true,
      dot: false, // Exclude dot files/folders by default
      ignore: excludePatterns  // Use the configurable exclude patterns
    });
    
    for (const file of files) {
      const relativePath = path.relative(workspacePath, file);
      
      // Apply gitignore filter if available
      if (!ignoreFilter || !ignoreFilter.ignores(relativePath)) {
        allFiles.add(file);
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage(`ConPlug: Error getting files from workspace: ${err}`);
  }
  
  return Array.from(allFiles);
}

export function deactivate() {
  // Clean up resources
  disposeFileWatchers();
  
  // Dispose file decoration provider if it exists
  if (fileDecorationProvider) {
    fileDecorationProvider.dispose();
    fileDecorationProvider = undefined;
  }
}

// Helper function to get diagnostic information
function getDiagnosticInfo(): string {
  let info = '# ConPlug Diagnostic Information\n\n';
  
  // Extension info
  info += '## Extension Information\n';
  info += `* Version: 1.0.0\n`;
  info += `* Commands Registered: showProfiles, formFile, updateFileDecorations, test\n`;
  
  // Profile info
  info += '\n## Profile Information\n';
  info += `* Current Profiles: ${currentProfiles.length > 0 ? currentProfiles.join(', ') : 'None'}\n`;
  info += `* Loaded Profiles: ${profiles.size}\n`;
  
  if (profiles.size > 0) {
    info += '\n### Available Profiles:\n';
    profiles.forEach((profile, name) => {
      info += `* ${name} (from ${profile.workspacePath})\n`;
      if (profile.parent && profile.parent.length > 0) {
        info += `  * Inherits from: ${profile.parent.join(', ')}\n`;
      }
      info += `  * Files: ${profile.files.length}, Excluded: ${profile.excluded.length}\n`;
    });
  }
  
  // Workspace info
  info += '\n## Workspace Information\n';
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    info += '* No workspace folders open\n';
  } else {
    info += `* Workspace Folders: ${workspaceFolders.length}\n`;
    workspaceFolders.forEach((folder, index) => {
      info += `  * ${index+1}: ${folder.name} (${folder.uri.fsPath})\n`;
      const configPath = path.join(folder.uri.fsPath, '.conplug');
      const hasConfig = fs.existsSync(configPath);
      info += `    * Has .conplug file: ${hasConfig ? 'Yes' : 'No'}\n`;
      info += `    * Loaded: ${loadedWorkspaceFolders.has(folder.uri.fsPath) ? 'Yes' : 'No'}\n`;
    });
  }
  
  // Command status
  info += '\n## Command Registration Status\n';
  try {
    // We can't properly handle this asynchronously in this context
    // So just indicate that we're checking
    info += `* Commands checked via test execution\n`;
    info += `* If you can run this test command, basic command registration is working\n`;
  } catch (error) {
    info += `* Error checking commands: ${error}\n`;
  }
  
  // File decoration status
  info += '\n## File Decoration Status\n';
  info += `* Files marked for concatenation: ${filesToConcatenateSet.size}\n`;
  
  // VSCode version
  info += '\n## VSCode Information\n';
  info += `* Version: ${vscode.version}\n`;
  
  return info;
} 