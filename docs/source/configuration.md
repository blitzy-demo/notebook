# Configuration

```{toctree}
:caption: Configuration
:maxdepth: 1

configuring/config_overview
Security <https://jupyter-server.readthedocs.io/en/stable/operators/security.html>
collaboration/admin_guide
extending/index.rst
```

## Collaborative Features Configuration

Jupyter Notebook v7 includes comprehensive real-time collaborative editing capabilities that enable multiple users to simultaneously edit the same notebook with live synchronization, user presence awareness, and intelligent conflict resolution.

### Key Collaboration Configuration Options

- **`c.NotebookApp.collaboration_enabled`** - Boolean flag to enable/disable collaborative features (default: False)
- **`--collaborative`** - Command-line flag to enable collaboration features
- **WebSocket endpoint configuration** - Collaboration requires WebSocket support at `/api/collaboration/ws`
- **Collaboration server URL settings** - Configure connection endpoints for multi-server deployments
- **Permission model configuration** - Role-based access control integrated with JupyterHub authentication

### Quick Start

To enable collaborative features:

```bash
# Enable collaboration via command-line flag
jupyter notebook --collaborative

# Or via configuration
c.NotebookApp.collaboration_enabled = True
```

### Resource Requirements

When collaboration is enabled:
- **Memory**: Additional ≥20% memory overhead for Yjs document management
- **Storage**: Persistent storage required for Yjs collaborative documents
- **Network**: WebSocket connectivity with sticky-session support for load-balanced deployments

For detailed deployment and configuration instructions for multi-user collaborative environments, see the {doc}`collaboration/admin_guide`.
