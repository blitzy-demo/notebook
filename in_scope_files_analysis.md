# IN-SCOPE FILES ANALYSIS - JUPYTER NOTEBOOK v7 COLLABORATION

## EXPLICITLY IN-SCOPE FILES (from Section 0.4.1)

### Core Implementation Files:
- `packages/notebook/src/model.ts` - Yjs integration
- `packages/notebook/src/widget.ts` - Presence tracking
- `packages/notebook/src/celloperations.ts` - Lock checking
- `packages/notebook/src/collab/*` - All new collaboration modules
- `packages/notebook-extension/src/components/*` - Collaboration UI components
- `packages/notebook-extension/src/index.ts` - Plugin registration
- `packages/notebook-extension/schema/*` - Collaboration settings schemas
- `packages/application/src/shell.ts` - Collaboration status display
- `packages/application/src/tokens.ts` - New DI tokens
- `notebook/app.py` - Server configuration
- `notebook/handlers.py` - WebSocket handlers
- `jupyter_server_config.d/notebook.json` - Collaboration settings

### Test Files (In-Scope if they exist):
- New test suites for collaboration features
- Integration tests for multi-user scenarios
- Performance benchmarks for concurrent edits
- Security tests for access control

### Configuration Files:
- New `c.NotebookApp.collaboration_enabled` flag configurations
- WebSocket endpoint configurations
- Collaboration server URL settings
- Permission model configurations

## EXPLICITLY OUT-OF-SCOPE (from Section 0.4.2)

### What we CANNOT modify:
- Core notebook file format (.ipynb)
- Kernel communication protocols
- Extension APIs unrelated to collaboration
- Authentication mechanisms (relies on existing)
- File system operations (uses existing Contents API)

### Features NOT implemented:
- Voice/video chat integration
- Screen sharing capabilities
- Collaborative debugging features
- Real-time kernel sharing
- Automatic merge of notebook outputs from different kernels
