# ConPlug v1.0.0 Release Notes

We're excited to announce the first stable release of ConPlug, a VSCode extension that makes concatenating your project files easier than ever!

## What is ConPlug?

ConPlug helps you easily combine multiple files from your project into a single file. This is perfect for:
- Sharing code with colleagues
- Creating code snippets for documentation
- Submitting code for review
- Preparing code for AI code assistants
- Creating backups of important files

## Key Features

- **Profile System**: Create reusable profiles to define which files to concatenate
- **Smart Selection**: Use direct file references, directories, or glob patterns
- **Inheritance**: Build hierarchical profiles that inherit from each other
- **Visual Indicators**: See which files are included in your active profiles
- **Customizable Output**: Configure file headers and comment styles
- **Multi-workspace Support**: Works with all your workspace folders
- **No Config Mode**: Works even without a configuration file

## Getting Started

1. Install ConPlug from the VSCode Marketplace
2. Create a `.conplug` file in your project root with profiles:
   ```
   main_profile {
     src/*.js
     README.md
     !src/test.js
   }
   ```
3. Press `Ctrl+Alt+P` to select your profile
4. Press `Ctrl+Alt+F` to generate your concatenated file

## Feedback & Support

We welcome your feedback and suggestions! Please report any issues or feature requests on our [GitHub repository](https://github.com/GoldenDeals/ConPlug.vscode.git).

Thank you for trying ConPlug!

---

## Full Changelog

For a complete list of changes, please see [CHANGELOG.md](./CHANGELOG.md) 