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
  console.log('ConPlug extension activated');

  // Store extension context
  extensionContext = context;

  // Load saved profiles from global state
  const savedProfiles = context.globalState.get<string[]>('currentProfiles', []);
  if (savedProfiles.length > 0) {
    currentProfiles = savedProfiles;
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('conplug.showProfiles', showProfiles),
    vscode.commands.registerCommand('conplug.formFile', formFile),
    vscode.commands.registerCommand('conplug.updateFileDecorations', updateFileDecorations)
  );

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

  // Get all files to concatenate
  const allFiles = new Set<string>();
  
  // If using special '_ALL_FILES_' mode, get all files from all workspaces
  if (currentProfiles.includes('_ALL_FILES_')) {
    // Ask for confirmation before processing all files
    const continueWithAllFiles = await vscode.window.showInformationMessage(
      'ConPlug: This will concatenate ALL files in the workspace and may be slow for large workspaces. Continue?',
      { modal: true },
      'Yes', 'No'
    );
    
    if (continueWithAllFiles !== 'Yes') {
      return;
    }
    
    // Show progress indicator while collecting files
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'ConPlug: Collecting files from workspace...',
      cancellable: false
    }, async (progress) => {
      // Collect all files from each workspace
      for (const folder of workspaceFolders) {
        const allWorkspaceFiles = getAllWorkspaceFiles(folder.uri.fsPath);
        allWorkspaceFiles.forEach(file => allFiles.add(file));
        progress.report({ message: `Found ${allFiles.size} files...` });
      }
    });
  }
  // Otherwise, use the selected profiles
  else {
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
  
  const filesToConcatenate = Array.from(allFiles);
  
  if (filesToConcatenate.length === 0) {
    vscode.window.showWarningMessage('ConPlug: No files to concatenate in the selected profiles');
    return;
  }

  // Update the filesToConcatenateSet with the resolved files
  filesToConcatenateSet.clear();
  filesToConcatenate.forEach(file => filesToConcatenateSet.add(file));
  
  // Force refresh of file decorations to show the marks
  vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');

  // Get plugin configuration
  const config = vscode.workspace.getConfiguration('conplug');
  const headerPrefix = config.get<string>('headerPrefix', "\n");
  const headerSuffix = config.get<string>('headerSuffix', "\n");

  // Concatenate files
  let content = '';
  for (const file of filesToConcatenate) {
    try {
      const fileContent = fs.readFileSync(file, 'utf8');
      // Find which workspace folder this file belongs to
      const workspaceFolder = getWorkspaceFolderForFile(file);
      if (!workspaceFolder) {
        vscode.window.showErrorMessage(`ConPlug: Could not determine workspace folder for ${file}`);
        continue;
      }
      
      const relativeFilePath = path.relative(workspaceFolder.uri.fsPath, file);
      const commentStyle = getCommentStyleForFile(file);
 
      // Special handling for HTML and CSS comments that need closing tags
      const ext = path.extname(file).toLowerCase();
      if (['.html', '.xml', '.svg', '.jsx', '.tsx'].includes(ext)) {
        content += `${headerPrefix}<!-- File: ${relativeFilePath} -->${headerSuffix}${fileContent}\n\n`;
      } else if (['.css', '.scss', '.less'].includes(ext)) {
        content += `${headerPrefix}/* File: ${relativeFilePath} */${headerSuffix}${fileContent}\n\n`;
      } else {
        content += `${headerPrefix}${commentStyle} File: ${relativeFilePath}${headerSuffix}${fileContent}\n\n`;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`ConPlug: Error reading file ${file}`);
    }
  }

  // Copy to clipboard if configured
  if (config.get<boolean>('autoCopyToClipboard')) {
    await vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage('ConPlug: Concatenated content copied to clipboard');
  }

  // Show in a new editor
  const doc = await vscode.workspace.openTextDocument({ content });
  await vscode.window.showTextDocument(doc);
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