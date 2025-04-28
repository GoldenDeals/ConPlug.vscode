# Changelog

All notable changes to the ConPlug extension will be documented in this file.

## [1.0.0] - 2023-07-20

### Initial Release 🎉

#### Features
- Profile-based file concatenation system
- Multiple profile selection support
- Hierarchical profiles with inheritance capabilities
- Visual indicators for files included in active profiles
- Syntax highlighting for `.conplug` configuration files
- Custom file header comments with configurable prefix and suffix
- Auto-copy to clipboard functionality
- Support for all workspace folders in multi-root workspaces
- File decorations in the explorer view
- Support for working without a configuration file (all files mode)

#### File Patterns Support
- Direct file references
- Directory inclusion
- Glob pattern matching
- File and pattern exclusions with `!` prefix
- Respect for `.gitignore` rules (configurable)

#### Configuration Options
- Customizable comment styles based on file extension
- Configurable file decoration symbol
- Exclude patterns for workspace scanning
- Header prefix and suffix customization
- Toggle for auto-copy to clipboard

#### Key Bindings
- `Ctrl+Alt+P` (`Cmd+Alt+P` on Mac) - Show and select profiles
- `Ctrl+Alt+F` (`Cmd+Alt+F` on Mac) - Form concatenated file

#### Performance Optimizations
- Efficient file watching for configuration changes
- Smart caching of loaded workspace folders
- Optimized glob pattern expansion
- Background file processing for large workspaces

---

The ConPlug team is excited to release the first stable version of our extension. We've worked hard to create a tool that makes sharing and working with multiple files easier than ever. We welcome your feedback and suggestions for future improvements! 