# ConPlug VSCode Extension

VSCode extension to conveniently concatenate files of your project.

## Overview

ConPlug helps you easily combine multiple files from your project into a single file. This is useful for:
- Sharing code with colleagues
- Creating code snippets for documentation
- Submitting code for review
- Preparing code for AI code assistants
- Creating backups of important files

## Installation

Install from the VSCode Marketplace or search for "ConPlug" in the Extensions tab within VSCode.

## Key Bindings

- `Ctrl + Alt + P` (`Cmd + Alt + P` on Mac) - Show list of profiles and choose current profile(s)
- `Ctrl + Alt + F` (`Cmd + Alt + F` on Mac) - Form a concatenated file and copy its content to clipboard (if enabled in settings)

## Features
- Create reusable profiles to define which files to concatenate
- Concatenate files according to profile configurations
- Support for glob patterns and file/directory exclusions
- Hierarchical profiles with inheritance
- Auto-copy to clipboard
- Visual indicators in the file explorer for included files
- Syntax highlighting for `.conplug` configuration files
- Customizable file headers and comment styles

## Profiles
Each project can have a `.conplug` file that contains lists of files to be concatenated.

### File Format
You can use a Glob format (similar to `.gitignore`) when describing files. Syntax highlighting is provided by this extension.

```
# myProject/.conplug

profile1 {
    file1.js
    dir1/
    dir1/*.js
}

childProfile: profile1 {  # childProfile inherits profile1 and contains all of its entries
    hello.js
}

third: childProfile, profile1 {
    !hello.js   # Files can be excluded with the ! prefix
    bye.js
}
```

### Profile Inheritance
Profiles can inherit from other profiles using the colon syntax:
```
childProfile: parentProfile {
    additional_file.js
}
```

Multiple inheritance is supported:
```
combined: profile1, profile2 {
    # Additional files or exclusions
}
```

### File Patterns
- Direct file references: `file.js`
- Entire directories: `src/`
- Glob patterns: `*.js`, `src/**/*.ts`
- Exclusions: `!node_modules/`, `!*.test.js`

## Configuration

ConPlug offers several configuration options that can be set in your VSCode settings:

```json
{
  "conplug.includeGitIgnored": false,
  "conplug.autoCopyToClipboard": true,
  "conplug.headerPrefix": "\n",
  "conplug.headerSuffix": "\n",
  "conplug.fileDecorationSymbol": "🐺",
  "conplug.excludePatterns": [
    "**/node_modules/**",
    "**/.git/**",
    "**/out/**",
    "**/dist/**",
    "**/build/**"
  ],
  "conplug.languageCommentMap": {
    ".py": "#",
    ".js": "//",
    ".ts": "//",
    ".sql": "--",
    "default": "//"
  }
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `includeGitIgnored` | Include files in `.gitignore` when added by glob pattern | `false` |
| `autoCopyToClipboard` | Automatically copy to clipboard when file is formed | `true` |
| `headerPrefix` | Text to insert before each file header comment | `"\n"` |
| `headerSuffix` | Text to insert after each file header comment | `"\n"` |
| `fileDecorationSymbol` | Symbol to use as a badge for files included in active profile(s) | `"🐺"` |
| `excludePatterns` | Glob patterns to exclude when using 'all files' mode | See default in example |
| `languageCommentMap` | Mapping of file extensions to comment styles | See default in example |

## Usage Examples

### Basic Usage

1. Create a `.conplug` file in your project root
2. Define profiles with the files you want to include
3. Press `Ctrl+Alt+P` to select a profile
4. Press `Ctrl+Alt+F` to generate the concatenated file

### Advanced Usage

#### Creating a Profile for Your Core Application Files

```
core_app {
    src/models/
    src/controllers/
    src/app.js
    !src/**/*.test.js
}
```

#### Creating Documentation Files

```
documentation {
    README.md
    docs/
    examples/*.js
}
```

#### Sharing a Specific Feature with Colleagues

```
auth_feature {
    src/auth/*.js
    src/models/user.js
    src/middleware/auth.js
    test/auth/basic.test.js
}
```

## Working Without a Configuration File

If no `.conplug` file is found, ConPlug can still concatenate all files in your workspace. When you run the "Show profiles" command, you'll be prompted to use all files in the workspace.

## Troubleshooting

- If files aren't being included, check if they're excluded by your `.gitignore` file
- For large projects, consider using more specific file patterns to improve performance
- Use the file decoration indicators to verify which files will be included

## Contributing

Contributions are welcome! Feel free to submit issues or pull requests on the [GitHub repository](https://github.com/GoldenDeals/ConPlug.vscode.git).

## License

MIT