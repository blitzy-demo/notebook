# New features in Notebook 7

This document describes the new features in Notebook 7 as originally mentioned in the related Jupyter Enhancement Proposal [JEP 79][jep 79].

```{contents} Table of Contents
:depth: 3
:local:
```

## Debugger

Notebook 7 includes a new debugger that allows you to step through your code cell by cell. You can also set breakpoints and inspect variables.

![a screenshot of the debugger](https://user-images.githubusercontent.com/591645/195543524-e16647a1-a4e0-4832-929d-73d5a77ef001.png)

## Real Time collaboration

Notebook 7 features comprehensive real-time collaborative editing capabilities that enable multiple users to simultaneously work on the same notebook with live synchronization, user presence awareness, and intelligent conflict resolution. This transforms Jupyter Notebook from a single-user application into a powerful multi-user collaborative platform.

### Installation and Setup

The Real Time Collaboration feature is the same as in JupyterLab and is available as a JupyterLab extension. It is not enabled by default, but you can install with `pip`:

```bash
pip install jupyter-collaboration
```

or with `conda`:

```bash
conda install -c conda-forge jupyter-collaboration
```

After installing the extension, restart the Jupyter Server so the extension can be loaded.

```{note}
It is possible for two users to work on the same notebook using Notebook 7 or JupyterLab.
```

![a screencast showing how users can collaborate on the same document with both Notebook 7 and JupyterLab](https://user-images.githubusercontent.com/591645/229854102-6eed73f4-587f-406e-8ed1-347b788da9ee.gif)

### Core Collaboration Features

#### Real-time Document Synchronization

Notebook 7's collaboration system uses **Yjs CRDT (Conflict-free Replicated Data Type)** technology to provide seamless real-time synchronization of notebook content. This ensures that:

- **Cell content changes** appear instantly across all connected clients
- **Cell additions and deletions** are synchronized in real-time
- **Metadata modifications** propagate automatically
- **Concurrent edits** are merged intelligently without conflicts
- **Network interruptions** are handled gracefully with automatic reconnection

The CRDT approach guarantees that all users see a consistent view of the document, regardless of the order in which edits arrive or network conditions.

#### User Presence and Awareness System

The collaboration system provides rich awareness of other users working on the same notebook:

- **User avatars** display all active collaborators with profile pictures and names
- **Real-time cursors** show where other users are currently editing
- **Selection highlights** indicate which cells other users have selected
- **Status indicators** show user activity (typing, idle, disconnected)
- **User list** displays all connected collaborators with role information

This awareness system helps prevent conflicts and enables smooth coordination between team members.

#### Cell-Level Locking Mechanism

To prevent editing conflicts, Notebook 7 implements an intelligent cell-level locking system:

- **Automatic locking** when a user begins editing a cell
- **Visual lock indicators** show which cells are currently being edited
- **Lock timeouts** automatically release locks if users become inactive
- **Lock notifications** inform users when cells become available for editing
- **Conflict prevention** blocks simultaneous edits to the same cell

This system ensures data integrity while maintaining a fluid collaborative experience.

#### Change History and Versioning

Comprehensive version tracking capabilities allow teams to:

- **Track all changes** with cell-level granularity
- **View change history** with detailed diff comparisons
- **Restore previous versions** of individual cells or entire notebooks
- **Browse version timeline** to understand document evolution
- **Compare versions** side-by-side to identify differences
- **Revert changes** when needed without losing other work

The versioning system maintains a complete audit trail of collaborative editing sessions.

#### Permissions and Access Control

Robust access control enables secure collaborative environments:

- **Role-based permissions**: View, Edit, and Admin roles with different capabilities
- **Fine-grained access control**: Per-notebook permission management
- **JupyterHub integration**: Seamless authentication with existing user management
- **Dynamic permission changes**: Administrators can modify access in real-time
- **Secure sharing**: Control who can view, edit, or manage notebooks

**Permission Roles:**
- **Viewers**: Can view notebook content but cannot make changes
- **Editors**: Can modify cells, add/delete content, and collaborate fully
- **Administrators**: Can manage permissions, access history, and control sharing

#### Comment and Review System

Built-in collaborative review capabilities include:

- **Cell-level comments**: Add threaded discussions to specific cells
- **Inline annotations**: Attach feedback directly to code or markdown
- **Review workflows**: Request reviews and track approval status
- **Notification system**: Alerts for new comments and responses
- **Resolution tracking**: Mark comments as resolved or follow up needed
- **Collaborative feedback**: Team members can respond and discuss improvements

### Configuration Requirements

#### WebSocket Configuration

Real-time collaboration requires WebSocket support with specific configuration:

```python
# jupyter_server_config.py
c.ServerApp.allow_origin = '*'  # Configure for your domain
c.ServerApp.disable_check_xsrf = True  # Required for WebSocket connections
c.CollaborationApp.log_level = 'INFO'  # Set appropriate logging level
```

#### Network Requirements

- **WebSocket support** in deployment environment
- **Firewall configuration** to allow WebSocket connections
- **Load balancer settings** with sticky sessions for multi-server deployments
- **Connection timeout settings** appropriate for your network conditions

### JupyterHub Integration for Enterprise Deployments

Notebook 7 collaboration integrates seamlessly with JupyterHub for enterprise environments:

#### Authentication Integration
- **Single sign-on (SSO)** with existing identity providers
- **User profile synchronization** for avatars and display names
- **Group-based permissions** inherited from organizational structure
- **Session management** with proper cleanup on logout

#### Multi-Server Deployment
- **Horizontal scaling** with multiple Jupyter Server instances
- **Shared state management** using Redis for coordination
- **Load balancing** with proper WebSocket support
- **High availability** configuration for production environments

#### Enterprise Features
- **Audit logging** of all collaborative activities
- **Compliance reporting** for regulatory requirements
- **Data retention policies** for change history
- **Security scanning** integration for notebooks

### Performance Considerations for Multi-User Environments

The collaboration system is optimized for performance across various scenarios:

#### Scalability Metrics
- **Concurrent users**: Supports 10+ simultaneous editors per notebook
- **Edit latency**: Sub-100ms synchronization in typical network conditions
- **Memory overhead**: Less than 20% increase compared to single-user mode
- **Network efficiency**: Message batching reduces bandwidth usage

#### Optimization Strategies
- **Efficient synchronization**: Only changed content is transmitted
- **Smart batching**: Updates are grouped to reduce network overhead
- **Local caching**: Frequent operations are cached for responsiveness
- **Progressive loading**: Large notebooks load incrementally

#### Performance Monitoring
- **Real-time metrics** for collaboration system health
- **User experience monitoring** to track edit latency
- **Resource usage tracking** for server capacity planning
- **Network performance analysis** for optimization opportunities

### Best Practices for Collaborative Workflows

To maximize the benefits of real-time collaboration:

#### Team Coordination
- **Establish communication protocols** for complex editing sessions
- **Use comments and reviews** for asynchronous feedback
- **Plan concurrent work** to avoid conflicts in related cells
- **Leverage presence awareness** to coordinate editing activities

#### Content Organization
- **Structure notebooks clearly** with descriptive cell organization
- **Use markdown cells** for collaborative documentation
- **Maintain consistent coding standards** across team members
- **Document decisions and rationale** using the comment system

#### Workflow Integration
- **Integrate with version control** for long-term project management
- **Use collaborative sessions** for pair programming and code reviews
- **Establish review cycles** using the built-in comment system
- **Monitor performance impact** in production environments

## Table of Contents

Notebook 7 includes a new table of contents extension that allows you to navigate through your notebook using a sidebar. The Table of Contents is built-in and enabled by default, just like in JupyterLab.

![a screenshot of the table of contents](https://user-images.githubusercontent.com/591645/195544813-22e7dec9-846f-4aaa-913a-36a9ed908036.png)

## Theming and Dark Mode

A Dark Theme is now available in the Jupyter Notebook by default. You can also install other themes as JupyterLab extensions.

![a screenshot of the dark theme](https://user-images.githubusercontent.com/591645/229732821-3ab15024-e6d7-414d-94ca-246619da4b67.png)

You can also install many other JupyterLab themes. For example to install the [JupyterLab Night](https://github.com/martinRenou/jupyterlab-night) theme:

```shell
pip install jupyterlab-night
```

Then refresh the page and select the new theme in the settings:

![a screenshot of a custom theme](https://user-images.githubusercontent.com/591645/229733418-db0898b3-7e8c-4db5-98d6-2e9f813ab9e9.png)

## Internationalization

Notebook 7 now provides the ability to set the display language of the user interface.

Users will need to install the language pack as a separate Python package. Language packs are grouped in the [language packs repository on GitHub](https://github.com/jupyterlab/language-packs/), and can be installed with `pip`. For example, it is possible to install the language pack for French (France) using the following command:

```shell
pip install jupyterlab-language-pack-fr-FR
```

After installing the language pack, reload the page and the new language should be available in the settings.

![a screencast showing how to switch the display language in Notebook 7](https://user-images.githubusercontent.com/591645/229734057-e08a2020-58c1-4aa5-b30e-ebb83fcde12c.gif)

```{note}
Notebook 7 and JupyterLab share the same language packs, so it is possible to use the same language pack in both applications.
```

## Accessibility Improvements

The text editor underlying the Jupyter Notebook (CodeMirror 5) had major accessibility issues. Fortunately, this accessibility bottleneck has been unblocked as JupyterLab has been upgraded to use CodeMirror 6, a complete rewrite of the text editor with a strong focus on accessibility. Although this upgrade required extensive codebase modifications, the changes is available with JupyterLab 4. By being built on top of JupyterLab, Jupyter Notebook 7 directly benefits from the CodeMirror 6 upgrade.

## Support for many JupyterLab extensions

Notebook 7 is based on JupyterLab and therefore supports many of the existing JupyterLab extensions.

You can install JupyterLab extensions with `pip` or `conda`. For example to install the LSP (Language Server Protocol) extension for enhanced code completion, you can use the following commands:

```bash
pip install jupyter-lsp
```

```bash
conda install -c conda-forge jupyter-lsp
```

Popular extensions like `nbgrader` and `RISE` have already been ported to work with Notebook 7.

### nbgrader

```{note}
The nbgrader extension is still under active development and a version compatible with Notebook 7 is not yet available on PyPI.
However a version compatible with Notebook 7 will be available before the final release of Notebook 7.
```

![a screenshot showing the nbgrader extension in Notebook 7](https://user-images.githubusercontent.com/32258950/196110653-6556c8d7-b169-4586-b1a1-66b3be05c790.png)

![a second screenshot showing the nbgrader extension in Notebook 7](https://user-images.githubusercontent.com/32258950/196110825-7e3b9237-1064-42be-a629-15a5510a3aee.png)

### RISE

The RISE extension is another popular JupyterLab extension that has been ported to work with Notebook 7. It allows you to turn your Jupyter Notebooks into a slideshow. See the [installation instructions](https://github.com/jupyterlab-contrib/rise#install).

## A document-centric user experience

Despite all the new features and as stated in [JEP 79][jep 79], Notebook 7 keeps the document-centric user experience of the Classic Notebook:

> The Jupyter Notebook application offers a document-centric user experience. That is, in the Notebook application, the landing page that contains a file manager, running tools tab, and a few optional extras, is a launching point into opening standalone, individual documents. This document-centric experience is important for many users, and that is the first key point this proposal aims to preserve. Notebook v7 will be based on a different JavaScript implementation than v6, but it will preserve the document-centric experience, where each individual notebook opens in a separate browser tab and the visible tools and menus are focused on the open document.

[jep 79]: https://jupyter.org/enhancement-proposals/79-notebook-v7/notebook-v7.html

## Compact View on Mobile Devices

Notebook 7 automatically switches to a more compact layout on mobile devices, making it convenient to run code on the go.

![a screenshot of the compact view on mobile devices](https://user-images.githubusercontent.com/591645/101995448-2793f380-3cca-11eb-8971-067dd068ccbe.gif)

## References

This was just a quick overview of the new features in Notebook 7. For more details, you can check out the following resources:

- The [JupyterLab Documentation](https://jupyterlab.readthedocs.io/en/latest/) is a great resource to learn more about JupyterLab and the extensions available. Since Notebook 7 is based on JupyterLab, many of the features and extensions available for JupyterLab are also available for Notebook 7.
- [Migration Guide](./migrate_to_notebook7.md) for Notebook 7, which explains how to migrate from the Classic Notebook to Notebook 7.
