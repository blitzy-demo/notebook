# Migration Guide: Single-User to Multi-User Collaborative Jupyter Notebook

This guide provides comprehensive instructions for transitioning from single-user Jupyter Notebook installations to multi-user collaborative environments with real-time editing capabilities.

## Table of Contents

1. [Overview](#overview)
2. [Pre-Migration Assessment](#pre-migration-assessment)
3. [Understanding the Differences](#understanding-the-differences)
4. [Migration Planning](#migration-planning)
5. [Phased Migration Approach](#phased-migration-approach)
6. [Data Migration Considerations](#data-migration-considerations)
7. [JupyterHub Integration](#jupyterhub-integration)
8. [User Training and Change Management](#user-training-and-change-management)
9. [Security and Permissions](#security-and-permissions)
10. [Testing and Validation](#testing-and-validation)
11. [Monitoring and Performance](#monitoring-and-performance)
12. [Rollback Procedures](#rollback-procedures)
13. [Common Migration Scenarios](#common-migration-scenarios)
14. [Troubleshooting](#troubleshooting)
15. [Post-Migration Optimization](#post-migration-optimization)

## Overview

Jupyter Notebook v7 introduces optional real-time collaborative editing capabilities powered by the Yjs CRDT (Conflict-free Replicated Data Type) framework. This enhancement enables multiple users to simultaneously edit the same notebook with:

- **Real-time synchronization** of all content changes
- **User presence awareness** with avatars and cursor positions
- **Intelligent conflict resolution** using CRDT algorithms
- **Cell-level locking** to prevent simultaneous edits
- **Change history and versioning** for audit trails
- **Role-based permissions** (view, edit, admin)
- **Comment and review systems** for collaborative workflows

**Critical Design Principles:**
- **Backward Compatibility**: Single-user mode remains identical to previous versions
- **Optional Features**: Collaboration can be completely disabled
- **Graceful Degradation**: Falls back to single-user when WebSocket unavailable
- **Performance Guarantees**: <100ms edit latency, ≤20% memory overhead
- **Zero Configuration Impact**: Existing installations continue working unchanged

## Pre-Migration Assessment

### Infrastructure Assessment Checklist

Before beginning migration, evaluate your current environment:

#### Network Infrastructure
- [ ] **WebSocket Support**: Verify deployment supports WebSocket connections
- [ ] **Firewall Configuration**: Ensure WebSocket traffic allowed on collaboration endpoints
- [ ] **Load Balancer Compatibility**: Check if load balancers support WebSocket upgrade
- [ ] **SSL/TLS Configuration**: Confirm HTTPS support for secure WebSocket connections
- [ ] **Network Latency**: Measure network performance between users (target <100ms)
- [ ] **Bandwidth Assessment**: Evaluate available bandwidth (5-10KB/minute per user)

#### Server Infrastructure
- [ ] **Server Resources**: Assess CPU, memory, and storage capacity
- [ ] **Concurrent User Capacity**: Estimate peak collaborative user load
- [ ] **Storage Backend**: Evaluate storage for collaboration persistence
- [ ] **Backup Systems**: Review backup strategies for collaborative state
- [ ] **Monitoring Tools**: Identify monitoring capabilities for collaborative metrics

#### Authentication Systems
- [ ] **JupyterHub Deployment**: Assess current JupyterHub installation (if any)
- [ ] **User Authentication**: Identify authentication providers (LDAP, OAuth, etc.)
- [ ] **User Management**: Review user database and group memberships
- [ ] **Permission Systems**: Evaluate existing access control mechanisms

#### Current Usage Patterns
- [ ] **User Count**: Document current and projected user base
- [ ] **Notebook Sizes**: Assess typical notebook file sizes and complexity
- [ ] **Usage Patterns**: Analyze peak usage times and collaboration needs
- [ ] **Workflow Dependencies**: Identify existing integrations and extensions

### Compatibility Assessment

#### Version Requirements
- [ ] **Jupyter Notebook**: Confirm v7.0.0 or higher
- [ ] **Jupyter Server**: Verify v2.4.0 or higher required
- [ ] **Python Version**: Ensure Python 3.9+ compatibility
- [ ] **Node.js**: Confirm Node.js 18+ for build tools (if customizing)

#### Extension Compatibility
- [ ] **JupyterLab Extensions**: Inventory currently installed extensions
- [ ] **Custom Extensions**: Assess compatibility with collaborative features
- [ ] **Third-Party Integrations**: Review external tool integrations

#### Browser Compatibility
- [ ] **Modern Browser Support**: Verify users have compatible browsers
- [ ] **JavaScript Requirements**: Confirm JavaScript enabled in organizational policy
- [ ] **WebSocket Support**: Test WebSocket functionality in user browsers

## Understanding the Differences

### Single-User vs Collaborative Mode

| Aspect | Single-User Mode | Collaborative Mode |
|--------|------------------|-------------------|
| **User Access** | One user per notebook session | Multiple simultaneous users |
| **Data Synchronization** | Local changes only | Real-time CRDT synchronization |
| **Conflict Resolution** | Not applicable | Automatic CRDT merging |
| **User Awareness** | Solo editing | Presence indicators, cursors, avatars |
| **Locking Mechanism** | Not required | Cell-level distributed locking |
| **Change Tracking** | Manual save checkpoints | Continuous change history |
| **Permissions** | File system permissions only | Role-based access control |
| **Network Requirements** | HTTP/HTTPS only | WebSocket connections required |
| **Resource Usage** | Baseline performance | Up to 20% additional memory |
| **Authentication** | Single-user or basic auth | JupyterHub integration preferred |

### Technical Architecture Changes

#### Communication Layer
```mermaid
graph TB
    subgraph "Single-User Mode"
        A[Browser] <-->|HTTP/WebSocket| B[Jupyter Server]
        B <--> C[Kernel]
    end

    subgraph "Collaborative Mode"
        D[Browser A] <-->|HTTP/WebSocket| F[Jupyter Server]
        E[Browser B] <-->|HTTP/WebSocket| F
        F <--> G[Kernel A]
        F <--> H[Kernel B]
        F <--> I[Yjs WebSocket Handler]
        I <--> J[Collaboration Storage]
        I <--> K[Yjs Document State]
    end
```

#### Data Flow Comparison
- **Single-User**: Browser ↔ Server ↔ File System
- **Collaborative**: Browser A ↔ Yjs CRDT ↔ Server ↔ Yjs CRDT ↔ Browser B

## Migration Planning

### Decision Framework

Use this decision tree to determine your migration approach:

```mermaid
graph TD
    A[Start Migration Planning] --> B{Current Users}
    B -->|< 10 users| C[Small Team Migration]
    B -->|10-100 users| D[Medium Organization Migration]
    B -->|> 100 users| E[Enterprise Migration]

    C --> F{JupyterHub Required?}
    F -->|Yes| G[Install JupyterHub First]
    F -->|No| H[Direct Collaborative Upgrade]

    D --> I[JupyterHub Integration Required]
    I --> J[Phased Rollout Plan]

    E --> K[Comprehensive Enterprise Plan]
    K --> L[Infrastructure Assessment]
    L --> M[Pilot Program]
    M --> N[Staged Deployment]
```

### Migration Timeline Template

#### Small Team (1-4 weeks)
```
Week 1: Infrastructure Assessment & Planning
- [ ] Complete compatibility assessment
- [ ] Install/configure WebSocket infrastructure
- [ ] Set up staging environment

Week 2: Implementation & Testing
- [ ] Enable collaboration features
- [ ] Conduct user acceptance testing
- [ ] Train team members

Week 3-4: Production Deployment
- [ ] Deploy to production
- [ ] Monitor performance
- [ ] Gather feedback and optimize
```

#### Medium Organization (4-8 weeks)
```
Week 1-2: Assessment & Infrastructure
- [ ] Complete comprehensive assessment
- [ ] Plan JupyterHub integration
- [ ] Set up staging environments

Week 3-4: Pilot Program
- [ ] Deploy to pilot group (10-20% of users)
- [ ] Gather feedback and refine
- [ ] Develop training materials

Week 5-6: Phased Rollout
- [ ] Deploy to 50% of users
- [ ] Monitor performance metrics
- [ ] Address issues and optimize

Week 7-8: Full Deployment
- [ ] Complete rollout to all users
- [ ] Final optimization
- [ ] Documentation and knowledge transfer
```

#### Enterprise (8-16 weeks)
```
Week 1-4: Assessment & Planning
- [ ] Infrastructure assessment
- [ ] Security review and compliance
- [ ] Integration planning
- [ ] Resource allocation

Week 5-8: Infrastructure & Pilot
- [ ] Infrastructure deployment
- [ ] Security implementation
- [ ] Pilot with key stakeholders
- [ ] Change management preparation

Week 9-12: Staged Deployment
- [ ] Phased rollout by department/team
- [ ] Performance monitoring and tuning
- [ ] User training programs
- [ ] Issue resolution and support

Week 13-16: Completion & Optimization
- [ ] Full production deployment
- [ ] Performance optimization
- [ ] Knowledge transfer
- [ ] Success metrics analysis
```

### Resource Planning Guidelines

#### Memory Requirements
- **Base Installation**: Standard Jupyter Notebook memory usage
- **Collaborative Features**: Additional 20% memory overhead per session
- **Planning Formula**: `Total Memory = Base Memory × 1.2 × Peak Concurrent Users`

#### Storage Requirements
- **Notebook Files**: Existing .ipynb files (unchanged)
- **Collaboration State**: Additional .ydoc files alongside notebooks
- **History Storage**: Version snapshots (configurable retention)
- **Planning Formula**: `Additional Storage ≈ 10-30% of notebook storage`

#### Network Bandwidth
- **Per Active User**: 5-10KB/minute during collaborative editing
- **Peak Usage**: Multiply by maximum concurrent collaborators
- **WebSocket Connections**: Plan for persistent connections during sessions

## Phased Migration Approach

### Phase 1: Infrastructure Preparation (Week 1-2)

#### Objectives
- Establish WebSocket-capable infrastructure
- Configure collaboration storage backend
- Set up monitoring and logging
- Prepare staging environments

#### Infrastructure Setup

**WebSocket Configuration**
```bash
# Verify WebSocket support
jupyter notebook --collaborative --port=8888 --no-browser

# Test WebSocket connectivity
curl -i -N -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: test" \
     -H "Sec-WebSocket-Version: 13" \
     http://localhost:8888/api/collaboration/ws
```

**Collaboration Storage Configuration**
```python
# jupyter_notebook_config.py
c.NotebookApp.collaboration_enabled = True

# SQLite storage (recommended for single-server)
c.CollaborativeStorage.yjs_db_path = "/path/to/collaboration.db"

# File-based storage (default)
c.CollaborativeStorage.storage_type = "file"

# Redis for multi-server deployments
c.CollaborativeStorage.storage_type = "redis"
c.CollaborativeStorage.redis_url = "redis://localhost:6379/0"
```

#### Health Checks
- [ ] **WebSocket Connectivity**: Verify upgrade handshake works
- [ ] **Storage Backend**: Confirm collaboration data persistence
- [ ] **Authentication**: Test user authentication flow
- [ ] **Performance Baseline**: Establish single-user performance metrics

### Phase 2: Pilot Deployment (Week 3-4)

#### Objectives
- Deploy to selected pilot users (10-20% of total)
- Validate collaborative functionality
- Gather user feedback
- Identify performance issues

#### Pilot Selection Criteria
- **Technical Aptitude**: Users comfortable with new features
- **Representative Workflows**: Cover major use cases
- **Collaboration Need**: Users who would benefit from real-time collaboration
- **Feedback Willingness**: Users willing to provide detailed feedback

#### Pilot Configuration
```python
# Staged rollout configuration
c.NotebookApp.collaboration_enabled = True
c.CollaborativeFeatures.pilot_users = [
    'user1@example.com',
    'user2@example.com',
    # ... pilot user list
]
```

#### Validation Checklist
- [ ] **Multi-User Editing**: Multiple users can edit same notebook simultaneously
- [ ] **Real-Time Sync**: Changes appear immediately across all clients
- [ ] **Conflict Resolution**: CRDT automatically merges concurrent edits
- [ ] **Presence Indicators**: User avatars and cursors display correctly
- [ ] **Cell Locking**: Prevents simultaneous cell edits appropriately
- [ ] **Performance**: Latency remains under 100ms for typical operations
- [ ] **Fallback Behavior**: Graceful degradation when WebSocket unavailable

### Phase 3: Gradual Rollout (Week 5-8)

#### Objectives
- Expand to 50-75% of user base
- Monitor system performance under increased load
- Refine configuration and optimization
- Conduct user training at scale

#### Rollout Strategy
```python
# Progressive enablement by group
c.JupyterHub.collaborative_groups = [
    'data-science-team',
    'research-group-a',
    'education-staff',
    # Add groups progressively
]

# Feature flags for gradual introduction
c.CollaborativeFeatures.enable_presence = True
c.CollaborativeFeatures.enable_locking = True
c.CollaborativeFeatures.enable_comments = False  # Enable later
c.CollaborativeFeatures.enable_history = False  # Enable later
```

#### Monitoring Metrics
- **Performance Metrics**:
  - Edit operation latency (target: <100ms)
  - Memory usage per session (target: ≤20% overhead)
  - WebSocket connection stability
  - Synchronization conflicts and resolution time

- **User Experience Metrics**:
  - Collaborative session frequency and duration
  - User presence and activity patterns
  - Error rates and failure scenarios
  - User satisfaction feedback

### Phase 4: Full Production Deployment (Week 9-12)

#### Objectives
- Complete rollout to all users
- Enable all collaborative features
- Optimize performance based on usage patterns
- Establish operational procedures

#### Full Feature Enablement
```python
# Complete collaborative feature set
c.NotebookApp.collaboration_enabled = True
c.CollaborativeFeatures.enable_all = True

# Performance optimization
c.CollaborativeSync.batch_interval = 50  # ms
c.CollaborativeSync.max_batch_size = 100
c.CollaborativeAwareness.timeout = 30000  # ms

# Security settings
c.CollaborativePermissions.default_role = "edit"
c.CollaborativePermissions.admin_users = ['admin@example.com']
```

#### Go-Live Checklist
- [ ] **Infrastructure Monitoring**: All systems healthy and properly monitored
- [ ] **Performance Optimization**: System tuned for observed usage patterns
- [ ] **User Training**: All users trained on collaborative features
- [ ] **Support Documentation**: Comprehensive user and admin documentation
- [ ] **Backup Procedures**: Collaboration state included in backup strategy
- [ ] **Rollback Plan**: Verified rollback procedures available
- [ ] **Support Process**: Help desk trained on collaborative features

## Data Migration Considerations

### Notebook File Compatibility

**Critical Guarantee**: All existing .ipynb files remain fully compatible with both collaborative and non-collaborative modes.

#### File Format Compatibility Matrix
| Notebook Version | Single-User v7 | Collaborative v7 | Backward Compatibility |
|------------------|----------------|------------------|----------------------|
| **Notebook v6** | ✅ Full | ✅ Full | ✅ Yes |
| **Notebook v5** | ✅ Full | ✅ Full | ✅ Yes |
| **Notebook v4** | ✅ Full | ✅ Full | ✅ Yes |
| **Custom Formats** | ⚠️ Depends | ⚠️ Depends | ⚠️ Validate |

#### Collaboration State Storage
```
notebook-directory/
├── example.ipynb              # Original notebook (unchanged)
├── .collaboration/
│   └── example.ydoc          # Yjs collaboration state
└── .history/
    ├── example-v1.ipynb      # Version snapshots
    ├── example-v2.ipynb
    └── metadata.json
```

### User Workspace Migration

#### Individual User Migration
```python
# Migration script for user workspaces
def migrate_user_workspace(user_path):
    """
    Migrate user workspace to collaboration-ready state
    """
    notebooks = find_notebooks(user_path)

    for notebook in notebooks:
        # Validate notebook format
        validate_notebook_format(notebook)

        # Initialize collaboration state (optional)
        if create_collaboration_state:
            initialize_yjs_document(notebook)

        # Set up permissions
        set_default_permissions(notebook, user)

        # Create backup
        create_migration_backup(notebook)
```

#### Batch Migration Process
1. **Pre-Migration Backup**: Full system backup including all notebooks
2. **Format Validation**: Verify all notebooks use compatible formats
3. **Collaboration Initialization**: Optionally pre-create collaboration state
4. **Permission Assignment**: Set up default role-based permissions
5. **Verification**: Validate successful migration for sample notebooks

### Configuration Migration

#### Single-User to Multi-User Config
```python
# Before: Single-user configuration
# jupyter_notebook_config.py (old)
c.NotebookApp.port = 8888
c.NotebookApp.open_browser = False
c.NotebookApp.password = 'sha1:...'

# After: Collaborative configuration
# jupyter_notebook_config.py (new)
c.NotebookApp.port = 8888
c.NotebookApp.open_browser = False
c.NotebookApp.collaboration_enabled = True

# New collaborative settings
c.CollaborativeStorage.storage_type = "sqlite"
c.CollaborativeStorage.yjs_db_path = "/data/collaboration.db"
c.CollaborativePermissions.default_role = "edit"
c.CollaborativeSync.batch_interval = 50
```

#### JupyterHub Integration Config
```python
# jupyterhub_config.py additions
c.JupyterHub.services = [
    {
        'name': 'notebook-collaboration',
        'url': 'http://127.0.0.1:8888',
        'oauth_no_confirm': True,
    }
]

# Enable collaborative notebook spawning
c.Spawner.notebook_dir = '/home/{username}'
c.Spawner.cmd = ['jupyter-notebook', '--collaborative']
```

## JupyterHub Integration

### Architecture Overview

```mermaid
graph TB
    subgraph "JupyterHub Integration"
        A[JupyterHub] --> B[OAuth Provider]
        A --> C[User Database]
        A --> D[Spawner]

        D --> E[Notebook Server 1]
        D --> F[Notebook Server 2]
        D --> G[Notebook Server N]

        E --> H[Collaboration Handler]
        F --> I[Collaboration Handler]
        G --> J[Collaboration Handler]

        H --> K[Shared Collaboration Storage]
        I --> K
        J --> K
    end
```

### Authentication Flow

The collaborative features seamlessly integrate with JupyterHub's OAuth authentication:

1. **User Login**: Standard JupyterHub authentication
2. **Token Issuance**: JupyterHub provides OAuth token with user identity
3. **Notebook Access**: Token grants access to authorized notebooks
4. **Collaboration Join**: Token validates collaborative session participation
5. **Permission Enforcement**: Role-based permissions enforced through token claims

### Installation and Configuration

#### Prerequisites
- JupyterHub 3.0.0 or higher
- Existing user authentication (OAuth, LDAP, etc.)
- Configured user directory structure

#### Installation Steps
```bash
# Install JupyterHub with collaboration support
pip install jupyterhub>=3.0.0
pip install jupyter-notebook[collaboration]>=7.0.0

# Configure collaborative spawner
pip install dockerspawner  # or your preferred spawner
```

#### JupyterHub Configuration
```python
# jupyterhub_config.py
import os

# Basic hub configuration
c.JupyterHub.hub_ip = '0.0.0.0'
c.JupyterHub.hub_port = 8000

# OAuth configuration for collaboration
c.JupyterHub.oauth_callback_url = 'https://your-domain.com/hub/oauth_callback'

# User authentication
c.JupyterHub.authenticator_class = 'oauthenticator.GitHubOAuthenticator'
# or your preferred authenticator

# Spawner configuration with collaboration
c.JupyterHub.spawner_class = 'dockerspawner.DockerSpawner'
c.DockerSpawner.image = 'jupyter/minimal-notebook:latest'

# Collaborative notebook configuration
c.Spawner.cmd = ['jupyter-notebook', '--collaborative']
c.Spawner.args = [
    '--NotebookApp.allow_origin=*',
    '--NotebookApp.disable_check_xsrf=True',
]

# Enable collaborative services
c.JupyterHub.services = [
    {
        'name': 'collaboration-service',
        'url': 'http://127.0.0.1:8888/hub/collaboration',
        'oauth_no_confirm': True,
        'oauth_client_allowed_scopes': ['access:servers'],
    }
]
```

#### Collaboration-Specific Configuration
```python
# jupyter_notebook_config.py (applied to all spawned servers)
c.NotebookApp.collaboration_enabled = True
c.NotebookApp.allow_origin_pat = r'https://your-jupyterhub-domain.com'

# JupyterHub OAuth integration
c.NotebookApp.oauth_client_id = os.environ.get('JUPYTERHUB_CLIENT_ID')
c.NotebookApp.oauth_client_secret = os.environ.get('JUPYTERHUB_CLIENT_SECRET')
c.NotebookApp.oauth_redirect_uri = 'https://your-domain.com/hub/oauth_callback'

# Collaborative storage (shared across all users)
c.CollaborativeStorage.storage_type = "sqlite"
c.CollaborativeStorage.yjs_db_path = "/shared/collaboration/collaboration.db"

# Default permissions
c.CollaborativePermissions.default_role = "edit"
c.CollaborativePermissions.require_explicit_access = False
```

### User Management Integration

#### Group-Based Permissions
```python
# Map JupyterHub groups to collaboration roles
c.CollaborativePermissions.group_role_mapping = {
    'instructors': 'admin',
    'teaching-assistants': 'edit',
    'students': 'edit',
    'auditors': 'view',
}

# Notebook-specific permissions
c.CollaborativePermissions.notebook_permissions = {
    '/shared/assignments/': {
        'instructors': 'admin',
        'students': 'edit',
        'auditors': 'view',
    },
    '/private/': {
        'owner': 'admin',  # Special keyword for file owner
    }
}
```

#### Dynamic Permission Assignment
```python
# Custom permission hook
def custom_permission_check(user, notebook_path, requested_role):
    """Custom logic for determining user permissions"""

    # Owner always has admin access
    if is_notebook_owner(user, notebook_path):
        return 'admin'

    # Course-specific logic
    if '/courses/' in notebook_path:
        course = extract_course_from_path(notebook_path)
        if is_course_instructor(user, course):
            return 'admin'
        elif is_course_student(user, course):
            return 'edit'
        else:
            return None  # No access

    # Default group-based permissions
    return get_group_permission(user, notebook_path)

c.CollaborativePermissions.permission_hook = custom_permission_check
```

### Multi-Server Deployment

#### Shared Storage Configuration
```python
# All servers share Redis for collaboration state
c.CollaborativeStorage.storage_type = "redis"
c.CollaborativeStorage.redis_url = "redis://redis-cluster:6379/0"
c.CollaborativeStorage.redis_cluster = True

# Load balancer configuration (nginx example)
upstream notebook_backend {
    # Sticky sessions for WebSocket connections
    ip_hash;
    server notebook1:8888;
    server notebook2:8888;
    server notebook3:8888;
}

server {
    location /api/collaboration/ws {
        proxy_pass http://notebook_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## User Training and Change Management

### Training Program Structure

#### Training Levels

**Level 1: Basic Collaborative Features (All Users)**
- Understanding collaborative vs single-user modes
- Joining collaborative sessions
- User presence awareness (avatars, cursors)
- Basic etiquette for simultaneous editing

**Level 2: Advanced Collaboration (Power Users)**
- Cell locking mechanisms and conflict resolution
- Comment and review workflows
- Change history and version management
- Permission management

**Level 3: Administration (IT Staff/Instructors)**
- Enabling/disabling collaborative features
- Managing user permissions and roles
- Troubleshooting collaboration issues
- Performance monitoring and optimization

### Training Materials Template

#### Quick Start Guide (Level 1)
```markdown
# Collaborative Jupyter Notebook Quick Start

## Joining a Collaborative Session
1. Open notebook normally via URL or file browser
2. Look for collaboration status indicator in toolbar
3. See other users' avatars in the presence bar
4. Notice real-time cursor movements and selections

## Working with Others
- **Green cursor overlays** show where others are working
- **Cell locks** prevent editing conflicts (shown with lock icon)
- **Changes sync automatically** - no need to save manually
- **Respect others' work** - avoid editing cells others are actively using

## Best Practices
- Communicate with team members about who works on what sections
- Use comments to discuss changes and provide feedback
- Save regularly to create stable checkpoints
- Be patient if someone else is editing a cell you need
```

#### Advanced User Guide (Level 2)
```markdown
# Advanced Collaborative Features

## Understanding Cell Locks
- Cells automatically lock when someone starts editing
- Lock indicators show who is currently editing
- Locks automatically release after 30 seconds of inactivity
- Contact the person or wait for them to finish

## Using Comments and Reviews
- Click comment icon next to any cell to add feedback
- Thread comments for discussions
- Mark comments as resolved when addressed
- Use @mentions to notify specific users

## Version History and Recovery
- Access change history via View menu → History
- See who made what changes and when
- Restore previous versions if needed
- Compare versions with built-in diff viewer
```

#### Administrator Guide (Level 3)
```markdown
# Collaborative Notebook Administration

## Enabling Collaboration
```bash
# Command line
jupyter notebook --collaborative

# Configuration file
c.NotebookApp.collaboration_enabled = True
```

## Managing Permissions
```python
# Set default permissions
c.CollaborativePermissions.default_role = "edit"

# Restrict access to specific notebooks
c.CollaborativePermissions.notebook_permissions = {
    '/sensitive/': {'administrators': 'admin'}
}
```

## Monitoring Performance
- Check `/api/collaboration/sessions` for active sessions
- Monitor WebSocket connection health
- Review collaboration storage usage
- Analyze user activity patterns
```

### Change Management Strategy

#### Communication Plan
1. **Announcement** (4 weeks before): Introduce collaborative features and benefits
2. **Training Schedule** (3 weeks before): Announce training sessions and materials
3. **Pilot Program** (2 weeks before): Introduce pilot users and gather feedback
4. **Go-Live** (1 week before): Final preparations and expectations
5. **Post-Launch** (ongoing): Regular feedback collection and improvement

#### Resistance Management
- **Address concerns** about performance impact with concrete metrics
- **Demonstrate value** with specific use cases relevant to users
- **Provide fallback** options (single-user mode always available)
- **Gather feedback** continuously and implement improvements

#### Success Metrics
- **Adoption Rate**: Percentage of users actively using collaborative features
- **Session Quality**: Average session duration and user satisfaction
- **Productivity**: Time savings in collaborative workflows
- **Support Volume**: Reduction in collaboration-related support tickets

## Security and Permissions

### Role-Based Access Control

#### Permission Levels
| Role | Capabilities | Use Cases |
|------|-------------|-----------|
| **View** | Read notebook, see live changes, observe user presence | Students reviewing instructor demos, auditors, stakeholders reviewing results |
| **Edit** | All view capabilities plus edit cells, add comments, participate in discussions | Active collaborators, team members, students working on assignments |
| **Admin** | All edit capabilities plus manage permissions, control session access, moderate discussions | Instructors, project leads, notebook owners |

#### Implementation Example
```python
# Role-based permission configuration
c.CollaborativePermissions.role_definitions = {
    'view': {
        'can_read': True,
        'can_edit': False,
        'can_comment': True,
        'can_see_presence': True,
        'can_manage_permissions': False,
    },
    'edit': {
        'can_read': True,
        'can_edit': True,
        'can_comment': True,
        'can_see_presence': True,
        'can_manage_permissions': False,
    },
    'admin': {
        'can_read': True,
        'can_edit': True,
        'can_comment': True,
        'can_see_presence': True,
        'can_manage_permissions': True,
        'can_force_unlock_cells': True,
    }
}
```

### Authentication Security

#### WebSocket Authentication
WebSocket connections use identical authentication as HTTP requests:

```python
# Secure WebSocket configuration
c.NotebookApp.allow_origin_pat = r'https://your-domain\.com'
c.NotebookApp.disable_check_xsrf = False  # Keep XSRF protection
c.NotebookApp.cookie_secret_file = '/etc/jupyter/cookie_secret'

# Token-based authentication
c.NotebookApp.token = 'your-secure-token'
c.NotebookApp.password = 'argon2:...'  # Hashed password
```

#### JupyterHub OAuth Integration
```python
# OAuth security settings
c.NotebookApp.oauth_client_id = os.environ['JUPYTERHUB_CLIENT_ID']
c.NotebookApp.oauth_client_secret = os.environ['JUPYTERHUB_CLIENT_SECRET']
c.NotebookApp.oauth_callback_url = 'https://hub.domain.com/oauth_callback'

# Validate tokens with JupyterHub
c.CollaborativeAuth.token_validation_url = 'https://hub.domain.com/hub/api/user'
c.CollaborativeAuth.require_valid_token = True
```

### Data Protection

#### Content Sanitization
All user-provided content undergoes strict sanitization:

```python
# Security settings for user-generated content
c.CollaborativeSecurity.sanitize_presence_data = True
c.CollaborativeSecurity.max_comment_length = 1000
c.CollaborativeSecurity.allowed_html_tags = ['b', 'i', 'em', 'strong', 'code']

# Prevent XSS in user names and status
c.CollaborativeSecurity.sanitize_user_names = True
c.CollaborativeSecurity.max_display_name_length = 50
```

#### Cell-Level Security
```python
# Lock timeout for security (prevents indefinite locks)
c.CollaborativeLocking.max_lock_duration = 300  # 5 minutes
c.CollaborativeLocking.force_unlock_admins_only = True

# Content validation
c.CollaborativeValidation.validate_cell_content = True
c.CollaborativeValidation.max_cell_size = 1048576  # 1MB
```

### Audit and Compliance

#### Audit Logging Configuration
```python
# Comprehensive audit logging
c.CollaborativeAudit.log_all_changes = True
c.CollaborativeAudit.log_user_presence = True
c.CollaborativeAudit.log_permission_changes = True
c.CollaborativeAudit.log_file = '/var/log/jupyter/collaboration-audit.log'

# Log format includes:
# - Timestamp
# - User identity
# - Action type (edit, comment, join, leave)
# - Resource (notebook path, cell ID)
# - Result (success, failure, denied)
```

#### Compliance Features
- **Change Attribution**: All edits tagged with user identity and timestamp
- **Content Retention**: Configurable retention periods for change history
- **Access Records**: Complete log of who accessed what notebooks when
- **Permission Audits**: Track permission changes and approvals

## Testing and Validation

### Pre-Deployment Testing

#### Infrastructure Testing
```bash
#!/bin/bash
# Comprehensive infrastructure validation script

echo "Testing WebSocket connectivity..."
curl -i -N -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: test" \
     -H "Sec-WebSocket-Version: 13" \
     http://localhost:8888/api/collaboration/ws

echo "Testing collaboration storage..."
python -c "
from jupyter_collaboration.storage import CollaborativeStorage
storage = CollaborativeStorage()
storage.test_connection()
print('Storage connection successful')
"

echo "Testing authentication integration..."
python -c "
from jupyter_collaboration.auth import AuthManager
auth = AuthManager()
auth.test_token_validation()
print('Authentication integration successful')
"
```

#### Functional Test Suite
```python
import pytest
from selenium import webdriver
from jupyter_collaboration.testing import CollaborativeTestCase

class TestCollaborativeFeatures(CollaborativeTestCase):

    def test_multi_user_editing(self):
        """Test simultaneous editing by multiple users"""
        # Open notebook in two browser sessions
        browser1 = self.get_browser_session(user='alice')
        browser2 = self.get_browser_session(user='bob')

        # Navigate to same notebook
        notebook_url = '/notebooks/test.ipynb'
        browser1.get(self.base_url + notebook_url)
        browser2.get(self.base_url + notebook_url)

        # Verify presence indicators
        self.assert_user_presence(browser1, 'bob')
        self.assert_user_presence(browser2, 'alice')

        # Test concurrent editing
        cell1 = browser1.find_element_by_css_selector('.cell[data-cell-index="0"]')
        cell2 = browser2.find_element_by_css_selector('.cell[data-cell-index="1"]')

        # Edit different cells simultaneously
        self.edit_cell_content(cell1, 'print("Hello from Alice")')
        self.edit_cell_content(cell2, 'print("Hello from Bob")')

        # Verify synchronization
        self.wait_for_sync()
        self.assert_cell_content(browser1, 1, 'print("Hello from Bob")')
        self.assert_cell_content(browser2, 0, 'print("Hello from Alice")')

    def test_cell_locking(self):
        """Test cell locking prevents conflicts"""
        browser1 = self.get_browser_session(user='alice')
        browser2 = self.get_browser_session(user='bob')

        # Alice starts editing a cell
        cell = browser1.find_element_by_css_selector('.cell[data-cell-index="0"]')
        self.start_cell_edit(cell)

        # Verify lock indicator appears for Bob
        cell_bob = browser2.find_element_by_css_selector('.cell[data-cell-index="0"]')
        self.assert_cell_locked(cell_bob, locked_by='alice')

        # Bob cannot edit locked cell
        self.assert_cell_not_editable(cell_bob)

        # Alice finishes editing
        self.finish_cell_edit(cell)

        # Lock is released
        self.assert_cell_unlocked(cell_bob)
        self.assert_cell_editable(cell_bob)

    def test_conflict_resolution(self):
        """Test CRDT conflict resolution"""
        # Set up scenario with potential conflict
        browser1 = self.get_browser_session(user='alice')
        browser2 = self.get_browser_session(user='bob')

        # Simulate network partition
        self.simulate_network_partition(browser2)

        # Both users edit same cell (should create conflict)
        cell1 = browser1.find_element_by_css_selector('.cell[data-cell-index="0"]')
        cell2 = browser2.find_element_by_css_selector('.cell[data-cell-index="0"]')

        self.edit_cell_content(cell1, 'Alice was here')
        self.edit_cell_content(cell2, 'Bob was here')

        # Restore network connection
        self.restore_network_connection(browser2)

        # Verify automatic conflict resolution
        self.wait_for_sync()
        final_content = self.get_cell_content(cell1, 0)

        # CRDT should merge both changes
        assert 'Alice was here' in final_content or 'Bob was here' in final_content

        # Both browsers should show same final content
        self.assert_consistent_content(browser1, browser2)

    def test_performance_requirements(self):
        """Verify performance requirements are met"""
        import time

        browser = self.get_browser_session()

        # Measure edit latency
        start_time = time.time()
        self.edit_cell_content('.cell[data-cell-index="0"]', 'test content')
        self.wait_for_sync()
        latency = (time.time() - start_time) * 1000  # Convert to ms

        # Verify <100ms latency requirement
        assert latency < 100, f"Edit latency {latency}ms exceeds 100ms requirement"

        # Measure memory overhead
        memory_before = self.get_memory_usage()
        self.enable_collaboration()
        memory_after = self.get_memory_usage()

        memory_overhead = (memory_after - memory_before) / memory_before
        assert memory_overhead <= 0.20, f"Memory overhead {memory_overhead:.1%} exceeds 20% requirement"
```

### Load Testing

#### Multi-User Load Test
```python
import asyncio
import websockets
from concurrent.futures import ThreadPoolExecutor

async def simulate_collaborative_user(user_id, notebook_url, duration=60):
    """Simulate a collaborative user for load testing"""

    # Connect to collaboration WebSocket
    ws_url = f"ws://localhost:8888/api/collaboration/ws"

    async with websockets.connect(ws_url) as websocket:
        # Send join notebook message
        await websocket.send(json.dumps({
            'type': 'join_notebook',
            'notebook_path': notebook_url,
            'user_id': user_id
        }))

        # Simulate editing activity
        start_time = time.time()
        while time.time() - start_time < duration:
            # Simulate cell edit
            await websocket.send(json.dumps({
                'type': 'cell_update',
                'cell_id': f'cell-{random.randint(0, 10)}',
                'content': f'User {user_id} edit at {time.time()}',
                'user_id': user_id
            }))

            # Wait for server response
            response = await websocket.recv()

            # Simulate realistic editing intervals
            await asyncio.sleep(random.uniform(2, 10))

async def run_load_test(num_users=50, duration=300):
    """Run load test with specified number of concurrent users"""

    tasks = []
    for i in range(num_users):
        task = simulate_collaborative_user(f'user-{i}', '/test.ipynb', duration)
        tasks.append(task)

    # Run all users concurrently
    await asyncio.gather(*tasks)

# Run load test
if __name__ == "__main__":
    asyncio.run(run_load_test(num_users=100, duration=600))  # 100 users for 10 minutes
```

### User Acceptance Testing

#### UAT Test Plan Template
```markdown
# User Acceptance Test Plan: Collaborative Features

## Test Scenarios

### Scenario 1: Basic Collaboration
**Objective**: Verify users can collaborate on notebooks successfully
**Participants**: 2-3 test users
**Duration**: 30 minutes

**Test Steps**:
1. All users open same notebook simultaneously
2. Verify presence indicators show all users
3. Users edit different cells concurrently
4. Verify changes sync in real-time
5. Add comments to cells and verify visibility
6. Save notebook and verify changes persist

**Success Criteria**:
- [ ] All users visible in presence bar
- [ ] Cell edits appear within 2 seconds on other screens
- [ ] No data loss or corruption
- [ ] Comments display correctly for all users

### Scenario 2: Conflict Management
**Objective**: Test system behavior during potential conflicts
**Participants**: 2 test users
**Duration**: 15 minutes

**Test Steps**:
1. User A starts editing a cell
2. User B attempts to edit same cell
3. Verify User B sees lock indicator
4. User A finishes editing
5. User B can now edit the cell
6. Test abandoned lock timeout

**Success Criteria**:
- [ ] Clear lock indicators prevent conflicts
- [ ] Locks release automatically after timeout
- [ ] No content overwrites or loss

### Scenario 3: Performance Validation
**Objective**: Confirm acceptable performance under normal use
**Participants**: 5-10 test users
**Duration**: 45 minutes

**Test Steps**:
1. All users join notebook session
2. Perform intensive collaborative editing
3. Monitor system responsiveness
4. Measure edit operation latency
5. Check memory and CPU usage

**Success Criteria**:
- [ ] Edit latency consistently under 100ms
- [ ] No noticeable UI lag or freezing
- [ ] Memory usage within expected bounds
- [ ] All collaborative features remain responsive
```

## Monitoring and Performance

### Key Performance Indicators (KPIs)

#### System Performance Metrics
```python
# Monitoring configuration
c.CollaborativeMonitoring.enable_metrics = True
c.CollaborativeMonitoring.metrics_endpoint = '/api/collaboration/metrics'

# Key metrics to track:
PERFORMANCE_METRICS = {
    'edit_latency_ms': {
        'description': 'Time from edit to synchronization across clients',
        'target': '<100ms',
        'alert_threshold': '200ms'
    },
    'memory_overhead_percent': {
        'description': 'Additional memory usage for collaborative features',
        'target': '≤20%',
        'alert_threshold': '25%'
    },
    'websocket_connection_stability': {
        'description': 'Percentage of stable WebSocket connections',
        'target': '>99%',
        'alert_threshold': '95%'
    },
    'sync_conflict_rate': {
        'description': 'Frequency of CRDT merge conflicts',
        'target': '<1%',
        'alert_threshold': '5%'
    }
}
```

#### User Experience Metrics
```python
USER_METRICS = {
    'collaborative_session_frequency': {
        'description': 'Percentage of notebook sessions that are collaborative',
        'target': '>30%',  # Adjust based on organization
    },
    'average_collaborators_per_session': {
        'description': 'Mean number of simultaneous users per notebook',
        'target': '2-5 users',
    },
    'user_satisfaction_score': {
        'description': 'Survey-based satisfaction with collaborative features',
        'target': '>4.0/5.0',
    },
    'feature_adoption_rate': {
        'description': 'Percentage of users actively using collaborative features',
        'target': '>70%',
    }
}
```

### Monitoring Infrastructure

#### Prometheus/Grafana Setup
```yaml
# docker-compose.yml for monitoring stack
version: '3.8'
services:
  jupyter-notebook:
    image: jupyter/notebook:7.0-collaborative
    ports:
      - "8888:8888"
    environment:
      - JUPYTER_ENABLE_METRICS=true
    volumes:
      - ./notebooks:/home/jovyan/work

  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - ./grafana-dashboards:/var/lib/grafana/dashboards
```

#### Custom Metrics Collection
```python
# Custom metrics for collaborative features
from prometheus_client import Counter, Histogram, Gauge

# Define metrics
collaborative_sessions = Counter('collaborative_sessions_total',
                                'Total collaborative sessions started')
edit_latency = Histogram('edit_operation_latency_seconds',
                        'Latency of edit operations')
active_collaborators = Gauge('active_collaborators',
                           'Number of active collaborative users')
sync_conflicts = Counter('sync_conflicts_total',
                        'Total synchronization conflicts resolved')

# Instrument collaborative operations
class CollaborativeMetrics:
    @staticmethod
    def record_session_start():
        collaborative_sessions.inc()

    @staticmethod
    def record_edit_latency(latency_seconds):
        edit_latency.observe(latency_seconds)

    @staticmethod
    def update_active_users(count):
        active_collaborators.set(count)

    @staticmethod
    def record_sync_conflict():
        sync_conflicts.inc()
```

#### Alerting Rules
```yaml
# prometheus-alerts.yml
groups:
- name: jupyter-collaboration
  rules:
  - alert: HighEditLatency
    expr: histogram_quantile(0.95, edit_operation_latency_seconds) > 0.1
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High edit latency detected"
      description: "95th percentile edit latency is {{ $value }}s, above 100ms threshold"

  - alert: CollaborativeSessionFailures
    expr: increase(collaborative_session_errors_total[5m]) > 5
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Multiple collaborative session failures"
      description: "{{ $value }} session failures in last 5 minutes"

  - alert: MemoryUsageHigh
    expr: collaborative_memory_usage_percent > 25
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Collaborative memory usage above threshold"
      description: "Memory overhead is {{ $value }}%, above 25% threshold"
```

### Performance Optimization

#### WebSocket Connection Optimization
```python
# Optimize WebSocket connections for performance
c.CollaborativeTransport.websocket_compression = True
c.CollaborativeTransport.max_message_size = 65536  # 64KB
c.CollaborativeTransport.ping_interval = 30  # seconds
c.CollaborativeTransport.ping_timeout = 10   # seconds

# Connection pooling for multi-server deployments
c.CollaborativeTransport.connection_pool_size = 100
c.CollaborativeTransport.connection_pool_timeout = 30
```

#### CRDT Document Optimization
```python
# Yjs document optimization settings
c.CollaborativeYjs.document_gc_interval = 300  # 5 minutes
c.CollaborativeYjs.snapshot_interval = 1800    # 30 minutes
c.CollaborativeYjs.max_document_size = 10485760  # 10MB

# Update batching for performance
c.CollaborativeSync.batch_updates = True
c.CollaborativeSync.batch_interval_ms = 50
c.CollaborativeSync.max_batch_size = 100
```

#### Storage Performance Tuning
```python
# SQLite optimization for collaborative storage
c.CollaborativeStorage.sqlite_journal_mode = 'WAL'
c.CollaborativeStorage.sqlite_synchronous = 'NORMAL'
c.CollaborativeStorage.sqlite_cache_size = 10000
c.CollaborativeStorage.sqlite_busy_timeout = 30000

# Redis optimization for multi-server
c.CollaborativeStorage.redis_max_connections = 50
c.CollaborativeStorage.redis_connection_timeout = 5
c.CollaborativeStorage.redis_socket_keepalive = True
```

## Rollback Procedures

### Emergency Rollback Plan

#### Immediate Rollback (< 5 minutes)
```bash
#!/bin/bash
# Emergency rollback script - disables collaboration immediately

echo "EMERGENCY: Disabling collaborative features..."

# Method 1: Configuration override
export JUPYTER_COLLABORATION_DISABLED=true

# Method 2: Restart with single-user mode
sudo systemctl stop jupyterhub
sudo systemctl stop jupyter-notebook

# Edit configuration to disable collaboration
sed -i 's/collaboration_enabled = True/collaboration_enabled = False/' \
    /etc/jupyter/jupyter_notebook_config.py

# Restart services
sudo systemctl start jupyter-notebook
sudo systemctl start jupyterhub

echo "Collaborative features disabled. System running in single-user mode."
```

#### Graceful Rollback (15-30 minutes)
```bash
#!/bin/bash
# Graceful rollback with data preservation

echo "Initiating graceful rollback to single-user mode..."

# 1. Notify active users
python3 << EOF
from jupyter_collaboration.notifications import NotificationManager
nm = NotificationManager()
nm.broadcast_message("System maintenance: Collaborative features will be disabled in 5 minutes. Please save your work.")
EOF

# 2. Wait for user sessions to conclude
sleep 300  # 5 minutes

# 3. Disable new collaborative sessions
export JUPYTER_COLLABORATION_ACCEPT_NEW_SESSIONS=false

# 4. Wait for existing sessions to finish
python3 << EOF
from jupyter_collaboration.session_manager import SessionManager
sm = SessionManager()
sm.wait_for_sessions_to_end(timeout=1800)  # 30 minutes max
EOF

# 5. Backup collaboration state
mkdir -p /backup/collaboration/$(date +%Y%m%d_%H%M%S)
cp -r /data/collaboration/ /backup/collaboration/$(date +%Y%m%d_%H%M%S)/

# 6. Disable collaboration in configuration
sed -i 's/collaboration_enabled = True/collaboration_enabled = False/' \
    /etc/jupyter/jupyter_notebook_config.py

# 7. Restart services
sudo systemctl restart jupyterhub
sudo systemctl restart jupyter-notebook

echo "Graceful rollback completed successfully."
```

### Data Recovery Procedures

#### Collaboration State Recovery
```python
#!/usr/bin/env python3
# recover_collaboration_state.py

import sqlite3
import json
from pathlib import Path

def recover_notebook_from_yjs(notebook_path, yjs_db_path):
    """
    Recover notebook content from Yjs collaboration state
    """
    print(f"Recovering {notebook_path} from collaboration database...")

    # Connect to collaboration database
    conn = sqlite3.connect(yjs_db_path)
    cursor = conn.cursor()

    try:
        # Find Yjs document for notebook
        cursor.execute("""
            SELECT document_state FROM yjs_documents
            WHERE notebook_path = ?
            ORDER BY last_modified DESC
            LIMIT 1
        """, (notebook_path,))

        result = cursor.fetchone()
        if not result:
            print(f"No collaboration state found for {notebook_path}")
            return False

        # Decode Yjs document state
        yjs_state = result[0]
        notebook_content = decode_yjs_document(yjs_state)

        # Create recovery file
        recovery_path = Path(notebook_path).with_suffix('.recovered.ipynb')
        with open(recovery_path, 'w') as f:
            json.dump(notebook_content, f, indent=2)

        print(f"Recovered content saved to {recovery_path}")
        return True

    except Exception as e:
        print(f"Error recovering {notebook_path}: {e}")
        return False
    finally:
        conn.close()

def main():
    """Recover all notebooks from collaboration database"""
    yjs_db_path = "/data/collaboration/collaboration.db"

    if not Path(yjs_db_path).exists():
        print(f"Collaboration database not found: {yjs_db_path}")
        return

    # Get list of all notebooks in collaboration database
    conn = sqlite3.connect(yjs_db_path)
    cursor = conn.cursor()

    cursor.execute("SELECT DISTINCT notebook_path FROM yjs_documents")
    notebook_paths = [row[0] for row in cursor.fetchall()]
    conn.close()

    print(f"Found {len(notebook_paths)} notebooks in collaboration database")

    # Recover each notebook
    recovered = 0
    for notebook_path in notebook_paths:
        if recover_notebook_from_yjs(notebook_path, yjs_db_path):
            recovered += 1

    print(f"Successfully recovered {recovered}/{len(notebook_paths)} notebooks")

if __name__ == "__main__":
    main()
```

#### Backup Verification
```bash
#!/bin/bash
# verify_backup_integrity.sh

BACKUP_DIR="/backup/collaboration"
LATEST_BACKUP=$(ls -1t $BACKUP_DIR | head -1)

echo "Verifying backup integrity: $LATEST_BACKUP"

# Check collaboration database
if [ -f "$BACKUP_DIR/$LATEST_BACKUP/collaboration.db" ]; then
    echo "✓ Collaboration database found"

    # Test database integrity
    sqlite3 "$BACKUP_DIR/$LATEST_BACKUP/collaboration.db" "PRAGMA integrity_check;" > /tmp/db_check.txt
    if grep -q "ok" /tmp/db_check.txt; then
        echo "✓ Database integrity check passed"
    else
        echo "✗ Database integrity check failed"
    fi
else
    echo "✗ Collaboration database missing from backup"
fi

# Check notebook files
NOTEBOOK_COUNT=$(find "$BACKUP_DIR/$LATEST_BACKUP" -name "*.ipynb" | wc -l)
echo "✓ Found $NOTEBOOK_COUNT notebook files in backup"

# Check Yjs document files
YDOC_COUNT=$(find "$BACKUP_DIR/$LATEST_BACKUP" -name "*.ydoc" | wc -l)
echo "✓ Found $YDOC_COUNT Yjs document files in backup"

echo "Backup verification completed"
```

### Rollback Testing

#### Rollback Test Suite
```python
import pytest
import subprocess
import time
from pathlib import Path

class TestRollbackProcedures:

    def test_emergency_rollback(self):
        """Test emergency rollback procedure"""
        # Enable collaboration first
        self.enable_collaboration()
        assert self.is_collaboration_enabled()

        # Execute emergency rollback
        result = subprocess.run(['/usr/local/bin/emergency_rollback.sh'],
                              capture_output=True, text=True)
        assert result.returncode == 0

        # Verify collaboration disabled
        assert not self.is_collaboration_enabled()

        # Verify single-user functionality still works
        assert self.test_single_user_notebook_creation()
        assert self.test_single_user_notebook_execution()

    def test_graceful_rollback_with_active_sessions(self):
        """Test graceful rollback while users are collaborating"""
        # Set up active collaborative session
        session1 = self.create_collaborative_session('user1')
        session2 = self.create_collaborative_session('user2')

        # Start rollback process
        rollback_process = subprocess.Popen(['/usr/local/bin/graceful_rollback.sh'])

        # Sessions should continue working during grace period
        time.sleep(60)  # Wait 1 minute
        assert session1.is_active()
        assert session2.is_active()

        # Wait for rollback completion
        rollback_process.wait(timeout=1800)  # 30 minute timeout
        assert rollback_process.returncode == 0

        # Verify sessions ended gracefully
        assert not session1.is_active()
        assert not session2.is_active()

        # Verify collaboration disabled
        assert not self.is_collaboration_enabled()

    def test_data_recovery_after_rollback(self):
        """Test data recovery procedures work correctly"""
        # Create test notebook with collaborative content
        test_notebook = self.create_test_notebook_with_collaboration()
        original_content = test_notebook.get_content()

        # Perform rollback
        subprocess.run(['/usr/local/bin/graceful_rollback.sh'], check=True)

        # Test data recovery
        result = subprocess.run(['/usr/local/bin/recover_collaboration_state.py'],
                              capture_output=True, text=True)
        assert result.returncode == 0

        # Verify recovered content matches original
        recovered_file = Path(test_notebook.path).with_suffix('.recovered.ipynb')
        assert recovered_file.exists()

        recovered_content = self.load_notebook_content(recovered_file)
        assert self.notebooks_are_equivalent(original_content, recovered_content)
```

## Common Migration Scenarios

### Scenario 1: Small Team Adoption (2-10 Users)

#### Context
- Small research group or startup team
- Informal collaboration needs
- Limited IT infrastructure
- Budget constraints

#### Migration Approach
**Timeline**: 2-3 weeks
**Complexity**: Low
**Resource Requirements**: Minimal

#### Step-by-Step Guide
```bash
# Week 1: Setup and Testing
# Day 1-2: Environment preparation
pip install jupyter-notebook[collaboration]>=7.0.0

# Basic configuration
mkdir -p ~/.jupyter
cat > ~/.jupyter/jupyter_notebook_config.py << EOF
c.NotebookApp.collaboration_enabled = True
c.CollaborativeStorage.storage_type = "file"
c.CollaborativePermissions.default_role = "edit"
c.NotebookApp.open_browser = True
EOF

# Day 3-5: Team testing
jupyter notebook --collaborative --port=8888

# Week 2: Team Onboarding
# Create shared notebook directory
mkdir -p ~/shared_notebooks
cd ~/shared_notebooks

# Week 3: Production Use
# Monitor and optimize based on usage
```

#### Configuration Template
```python
# Small team configuration
c.NotebookApp.collaboration_enabled = True
c.NotebookApp.port = 8888
c.NotebookApp.ip = '0.0.0.0'  # Allow network access

# Simple file-based storage
c.CollaborativeStorage.storage_type = "file"
c.CollaborativeStorage.storage_path = "~/collaboration_data"

# Permissive permissions for small team
c.CollaborativePermissions.default_role = "edit"
c.CollaborativePermissions.require_explicit_access = False

# Basic performance settings
c.CollaborativeSync.batch_interval_ms = 50
c.CollaborativeAwareness.timeout_ms = 30000
```

#### Success Metrics
- All team members can collaborate simultaneously
- No significant performance degradation
- Adoption rate >80% within 2 weeks
- Zero data loss incidents

### Scenario 2: Educational Institution Deployment (50-500 Users)

#### Context
- University or large educational institution
- Mixed instructor/student usage patterns
- Existing JupyterHub deployment
- Need for access control and monitoring

#### Migration Approach
**Timeline**: 8-12 weeks
**Complexity**: Medium-High
**Resource Requirements**: Moderate

#### Phase-by-Phase Breakdown

**Phase 1: Infrastructure Assessment (Week 1-2)**
```bash
# Assess current JupyterHub deployment
jupyterhub --version  # Ensure 3.0.0+
pip list | grep jupyter  # Inventory current packages

# Test WebSocket infrastructure
python3 << EOF
import websockets
import asyncio

async def test_websocket():
    try:
        async with websockets.connect("ws://localhost:8000/hub/api/kernels") as ws:
            print("WebSocket connection successful")
    except Exception as e:
        print(f"WebSocket test failed: {e}")

asyncio.run(test_websocket())
EOF
```

**Phase 2: Pilot with Faculty (Week 3-4)**
```python
# jupyterhub_config.py - Pilot configuration
c.JupyterHub.authenticator_class = 'ldapauthenticator.LDAPAuthenticator'

# Enable collaboration for pilot users only
c.Spawner.cmd = ['jupyter-notebook']
c.Spawner.args = ['--collaboration-pilot-mode']

# Pilot-specific settings
pilot_users = ['prof.smith@university.edu', 'prof.jones@university.edu']
c.CollaborativeFeatures.enabled_users = pilot_users

# Enhanced monitoring for pilot
c.CollaborativeMonitoring.detailed_logging = True
c.CollaborativeMonitoring.performance_tracking = True
```

**Phase 3: Course Integration (Week 5-8)**
```python
# Course-based deployment configuration
c.CollaborativePermissions.group_role_mapping = {
    'course-cs101-instructors': 'admin',
    'course-cs101-tas': 'edit',
    'course-cs101-students': 'edit',
    'course-cs101-auditors': 'view',
}

# Course-specific notebook permissions
c.CollaborativePermissions.notebook_permissions = {
    '/shared/courses/cs101/assignments/': {
        'course-cs101-instructors': 'admin',
        'course-cs101-students': 'edit',
    },
    '/shared/courses/cs101/lectures/': {
        'course-cs101-instructors': 'admin',
        'course-cs101-students': 'view',
    }
}
```

**Phase 4: Full Deployment (Week 9-12)**
```python
# Production configuration for full deployment
c.NotebookApp.collaboration_enabled = True

# Scalable storage backend
c.CollaborativeStorage.storage_type = "postgresql"
c.CollaborativeStorage.database_url = "postgresql://user:pass@db-server:5432/collaboration"

# Performance optimization for large scale
c.CollaborativeSync.batch_interval_ms = 30
c.CollaborativeSync.max_concurrent_sessions = 1000
c.CollaborativeYjs.document_cache_size = 500

# Comprehensive monitoring
c.CollaborativeMonitoring.enable_prometheus = True
c.CollaborativeMonitoring.metrics_port = 9090
```

#### Educational-Specific Features
```python
# Assignment management integration
c.EducationalFeatures.assignment_mode = True
c.EducationalFeatures.submission_deadline_enforcement = True
c.EducationalFeatures.plagiarism_detection = True

# Grade integration hooks
c.EducationalFeatures.gradebook_integration = 'nbgrader'
c.EducationalFeatures.grade_cells_readonly = True

# Student collaboration controls
c.EducationalFeatures.max_collaborators_per_assignment = 3
c.EducationalFeatures.instructor_override_permissions = True
```

#### Success Metrics
- 95% uptime during peak usage hours
- <100ms edit latency for 95% of operations
- 70% instructor adoption within first semester
- 50% student usage for collaborative assignments
- Zero academic integrity violations due to system issues

### Scenario 3: Enterprise Migration (500+ Users)

#### Context
- Large corporation or enterprise
- Existing enterprise infrastructure
- Strict security and compliance requirements
- Global/distributed user base
- High availability requirements

#### Migration Approach
**Timeline**: 16-24 weeks
**Complexity**: High
**Resource Requirements**: Substantial

#### Enterprise Architecture
```mermaid
graph TB
    subgraph "Load Balancer Layer"
        LB[Load Balancer<br/>HAProxy/NGINX]
    end

    subgraph "Application Layer"
        JS1[JupyterHub Server 1]
        JS2[JupyterHub Server 2]
        JS3[JupyterHub Server N]
    end

    subgraph "Notebook Layer"
        NS1[Notebook Cluster 1]
        NS2[Notebook Cluster 2]
        NS3[Notebook Cluster N]
    end

    subgraph "Data Layer"
        DB[(PostgreSQL Cluster)]
        REDIS[(Redis Cluster)]
        NFS[Shared File Storage]
    end

    subgraph "Monitoring Layer"
        PROM[Prometheus]
        GRAF[Grafana]
        ELK[ELK Stack]
    end

    LB --> JS1
    LB --> JS2
    LB --> JS3

    JS1 --> NS1
    JS2 --> NS2
    JS3 --> NS3

    NS1 --> DB
    NS2 --> DB
    NS3 --> DB

    NS1 --> REDIS
    NS2 --> REDIS
    NS3 --> REDIS

    NS1 --> NFS
    NS2 --> NFS
    NS3 --> NFS

    NS1 --> PROM
    NS2 --> PROM
    NS3 --> PROM
```

#### Detailed Migration Plan

**Phase 1: Infrastructure Design & Security Review (Week 1-4)**
```yaml
# docker-compose.yml for enterprise deployment
version: '3.8'
services:
  jupyterhub:
    image: jupyterhub/jupyterhub:3.1
    deploy:
      replicas: 3
      resources:
        limits:
          memory: 4G
          cpus: '2'
    environment:
      - OAUTH_CLIENT_ID=${ENTERPRISE_OAUTH_ID}
      - OAUTH_CLIENT_SECRET=${ENTERPRISE_OAUTH_SECRET}
    volumes:
      - /enterprise/config:/srv/jupyterhub/config
      - /enterprise/ssl:/srv/jupyterhub/ssl

  collaboration-db:
    image: postgres:15
    deploy:
      replicas: 3
    environment:
      - POSTGRES_DB=collaboration
      - POSTGRES_USER=${DB_USER}
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    volumes:
      - collaboration_data:/var/lib/postgresql/data

  redis-cluster:
    image: redis:7-alpine
    deploy:
      replicas: 6
    command: redis-server --cluster-enabled yes --cluster-config-file nodes.conf

  monitoring:
    image: prom/prometheus
    deploy:
      replicas: 2
    volumes:
      - ./prometheus-config:/etc/prometheus
      - prometheus_data:/prometheus
```

**Phase 2: Pilot with Business Units (Week 5-8)**
```python
# Enterprise pilot configuration
c.JupyterHub.authenticator_class = 'oauthenticator.Generic'
c.GenericOAuthenticator.oauth_callback_url = 'https://jupyter.company.com/oauth_callback'
c.GenericOAuthenticator.client_id = os.environ['ENTERPRISE_OAUTH_ID']

# Business unit-based rollout
c.CollaborativeFeatures.enabled_business_units = [
    'data-science',
    'research-development',
]

# Enterprise security requirements
c.NotebookApp.ssl_options = {
    'keyfile': '/etc/ssl/private/jupyter.key',
    'certfile': '/etc/ssl/certs/jupyter.crt',
    'ca_certs': '/etc/ssl/certs/ca-bundle.crt',
}

# Audit logging for compliance
c.CollaborativeAudit.audit_logger = 'enterprise_logger'
c.CollaborativeAudit.compliance_mode = True
c.CollaborativeAudit.retention_days = 2555  # 7 years
```

**Phase 3: Regional Deployment (Week 9-16)**
```python
# Multi-region configuration
c.CollaborativeStorage.storage_type = "postgresql_cluster"
c.CollaborativeStorage.database_urls = {
    'us-east': 'postgresql://collab:pass@us-east-db:5432/collaboration',
    'us-west': 'postgresql://collab:pass@us-west-db:5432/collaboration',
    'eu-west': 'postgresql://collab:pass@eu-west-db:5432/collaboration',
}

# Redis cluster for cross-region synchronization
c.CollaborativeStorage.redis_cluster_nodes = [
    'redis-us-east:6379',
    'redis-us-west:6379',
    'redis-eu-west:6379',
]

# Performance optimization for global scale
c.CollaborativeSync.regional_batching = True
c.CollaborativeSync.cross_region_sync_interval = 100  # ms
c.CollaborativeYjs.distributed_document_cache = True
```

**Phase 4: Global Production Deployment (Week 17-24)**
```python
# Enterprise-grade configuration
c.CollaborativeScaling.auto_scaling_enabled = True
c.CollaborativeScaling.min_servers = 10
c.CollaborativeScaling.max_servers = 100
c.CollaborativeScaling.scale_up_threshold = 80  # CPU%
c.CollaborativeScaling.scale_down_threshold = 20  # CPU%

# High availability settings
c.CollaborativeHA.cluster_health_check_interval = 30  # seconds
c.CollaborativeHA.failover_timeout = 10  # seconds
c.CollaborativeHA.backup_server_ratio = 0.2  # 20% backup capacity

# Enterprise monitoring and alerting
c.EnterpriseMonitoring.alert_channels = [
    'slack://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    'email://oncall-team@company.com',
    'pagerduty://integration-key',
]

# Compliance and governance
c.EnterpriseGovernance.data_classification_enabled = True
c.EnterpriseGovernance.export_control_compliance = True
c.EnterpriseGovernance.gdpr_compliance_mode = True
```

#### Enterprise Security Configuration
```python
# Advanced security for enterprise deployment
c.EnterpriseSecurity.network_segmentation = True
c.EnterpriseSecurity.allowed_networks = [
    '10.0.0.0/8',      # Corporate network
    '172.16.0.0/12',   # VPN network
    '192.168.1.0/24',  # Remote office
]

# Identity and access management integration
c.EnterpriseSecurity.saml_integration = True
c.EnterpriseSecurity.mfa_required = True
c.EnterpriseSecurity.session_timeout = 28800  # 8 hours

# Data loss prevention
c.EnterpriseSecurity.dlp_enabled = True
c.EnterpriseSecurity.content_scanning = True
c.EnterpriseSecurity.export_restrictions = {
    'sensitive_data': 'require_approval',
    'customer_data': 'block_export',
    'financial_data': 'encrypt_and_log',
}

# Advanced threat protection
c.EnterpriseSecurity.anomaly_detection = True
c.EnterpriseSecurity.behavior_analysis = True
c.EnterpriseSecurity.threat_intelligence_feeds = [
    'corporate_threat_feed',
    'industry_threat_feed',
]
```

#### Success Metrics for Enterprise
- 99.9% uptime SLA compliance
- <50ms edit latency globally (95th percentile)
- Zero security incidents or data breaches
- 60% employee adoption within 6 months
- 25% productivity improvement in collaborative workflows
- Full compliance with industry regulations (SOX, GDPR, etc.)
- ROI positive within 18 months

## Troubleshooting

### Common Issues and Solutions

#### Issue 1: WebSocket Connection Failures

**Symptoms:**
- Collaboration features not working
- "Connection failed" messages
- Falling back to single-user mode

**Diagnosis:**
```bash
# Test WebSocket connectivity
curl -i -N -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
     -H "Sec-WebSocket-Version: 13" \
     http://localhost:8888/api/collaboration/ws

# Check firewall rules
sudo iptables -L | grep 8888
sudo ufw status | grep 8888

# Verify nginx/proxy configuration
nginx -t
systemctl status nginx
```

**Solutions:**
```python
# 1. Update nginx configuration for WebSocket support
# /etc/nginx/sites-available/jupyter
server {
    location /api/collaboration/ws {
        proxy_pass http://localhost:8888;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;  # 24 hours
    }
}

# 2. Configure firewall for WebSocket traffic
sudo ufw allow 8888/tcp
sudo iptables -A INPUT -p tcp --dport 8888 -j ACCEPT

# 3. Update Jupyter configuration
c.NotebookApp.allow_origin_pat = r'https://your-domain\.com'
c.NotebookApp.disable_check_xsrf = False  # Keep enabled for security
c.NotebookApp.tornado_settings = {
    'websocket_max_message_size': 1024 * 1024 * 10,  # 10MB
}
```

#### Issue 2: High Memory Usage

**Symptoms:**
- System becomes slow or unresponsive
- Memory usage continuously increasing
- Out of memory errors

**Diagnosis:**
```python
# Monitor memory usage by process
import psutil
import os

def diagnose_memory_usage():
    process = psutil.Process(os.getpid())
    memory_info = process.memory_info()

    print(f"RSS Memory: {memory_info.rss / 1024 / 1024:.2f} MB")
    print(f"VMS Memory: {memory_info.vms / 1024 / 1024:.2f} MB")

    # Check child processes
    children = process.children(recursive=True)
    total_memory = sum(child.memory_info().rss for child in children)
    print(f"Children Memory: {total_memory / 1024 / 1024:.2f} MB")

diagnose_memory_usage()
```

**Solutions:**
```python
# 1. Configure memory limits
c.CollaborativeYjs.max_document_size = 5 * 1024 * 1024  # 5MB
c.CollaborativeYjs.document_gc_interval = 60  # seconds
c.CollaborativeYjs.max_concurrent_documents = 100

# 2. Enable garbage collection
c.CollaborativeStorage.enable_gc = True
c.CollaborativeStorage.gc_interval = 300  # 5 minutes
c.CollaborativeStorage.max_idle_time = 1800  # 30 minutes

# 3. Implement document size limits
c.NotebookApp.max_notebook_size = 10 * 1024 * 1024  # 10MB
c.CollaborativeValidation.max_cell_size = 1024 * 1024  # 1MB

# 4. Monitor and alert on memory usage
c.CollaborativeMonitoring.memory_threshold = 80  # percent
c.CollaborativeMonitoring.memory_alert_enabled = True
```

#### Issue 3: Synchronization Conflicts

**Symptoms:**
- Content not syncing between users
- Users see different versions of notebook
- Edit operations failing

**Diagnosis:**
```python
# Check Yjs document state
from jupyter_collaboration.yjs_utils import YjsDocumentDiagnostic

def diagnose_sync_issues(notebook_path):
    diagnostic = YjsDocumentDiagnostic(notebook_path)

    print(f"Document State: {diagnostic.get_document_state()}")
    print(f"Pending Updates: {diagnostic.get_pending_updates()}")
    print(f"Conflict Count: {diagnostic.get_conflict_count()}")
    print(f"Last Sync: {diagnostic.get_last_sync_time()}")

    # Check network connectivity between clients
    connectivity_test = diagnostic.test_client_connectivity()
    print(f"Client Connectivity: {connectivity_test}")

diagnose_sync_issues('/path/to/notebook.ipynb')
```

**Solutions:**
```python
# 1. Increase sync timeouts
c.CollaborativeSync.operation_timeout = 10000  # 10 seconds
c.CollaborativeSync.retry_attempts = 5
c.CollaborativeSync.retry_delay = 1000  # 1 second

# 2. Improve conflict resolution
c.CollaborativeYjs.conflict_resolution_strategy = 'last_writer_wins'
c.CollaborativeYjs.enable_undo_redo = True
c.CollaborativeYjs.max_undo_stack_size = 50

# 3. Enable detailed sync logging
c.CollaborativeSync.debug_logging = True
c.CollaborativeSync.log_all_operations = True

# 4. Implement sync recovery mechanisms
c.CollaborativeSync.auto_recovery_enabled = True
c.CollaborativeSync.recovery_check_interval = 30  # seconds
```

#### Issue 4: Authentication Problems

**Symptoms:**
- Users cannot join collaborative sessions
- Permission denied errors
- Authentication token expiration

**Diagnosis:**
```bash
# Test authentication flow
curl -H "Authorization: token YOUR_TOKEN" \
     http://localhost:8888/api/collaboration/user

# Check JupyterHub integration
curl -H "Authorization: token YOUR_HUB_TOKEN" \
     http://jupyterhub:8000/hub/api/user

# Verify OAuth configuration
python3 << EOF
import requests
import os

hub_url = "http://jupyterhub:8000"
token = os.environ['JUPYTERHUB_API_TOKEN']

response = requests.get(f"{hub_url}/hub/api/user",
                       headers={'Authorization': f'token {token}'})
print(f"Status: {response.status_code}")
print(f"Response: {response.json()}")
EOF
```

**Solutions:**
```python
# 1. Fix OAuth configuration
c.NotebookApp.oauth_client_id = os.environ['JUPYTERHUB_CLIENT_ID']
c.NotebookApp.oauth_client_secret = os.environ['JUPYTERHUB_CLIENT_SECRET']
c.NotebookApp.oauth_callback_url = 'https://your-hub.com/hub/oauth_callback'

# 2. Extend token expiration
c.CollaborativeAuth.token_expiration = 86400  # 24 hours
c.CollaborativeAuth.auto_refresh_tokens = True
c.CollaborativeAuth.refresh_threshold = 3600  # 1 hour before expiry

# 3. Implement fallback authentication
c.CollaborativeAuth.fallback_to_password = True
c.CollaborativeAuth.allow_anonymous_view = False  # Security

# 4. Debug authentication
c.CollaborativeAuth.debug_logging = True
c.CollaborativeAuth.log_token_validation = True
```

### Performance Troubleshooting

#### Slow Edit Operations

**Diagnosis Tools:**
```python
# Performance profiling script
import time
import statistics
from jupyter_collaboration.performance import PerformanceProfiler

def profile_edit_operations(notebook_path, num_operations=100):
    profiler = PerformanceProfiler(notebook_path)
    latencies = []

    for i in range(num_operations):
        start_time = time.time()

        # Simulate edit operation
        profiler.simulate_cell_edit(f'cell-{i}', f'content-{i}')

        latency = (time.time() - start_time) * 1000  # Convert to ms
        latencies.append(latency)

    print(f"Mean latency: {statistics.mean(latencies):.2f}ms")
    print(f"Median latency: {statistics.median(latencies):.2f}ms")
    print(f"95th percentile: {statistics.quantiles(latencies, n=20)[18]:.2f}ms")
    print(f"99th percentile: {statistics.quantiles(latencies, n=100)[98]:.2f}ms")

profile_edit_operations('/test/notebook.ipynb')
```

**Optimization Solutions:**
```python
# Performance optimization configuration
c.CollaborativeSync.batch_updates = True
c.CollaborativeSync.batch_interval_ms = 50
c.CollaborativeSync.max_batch_size = 100

# Network optimization
c.CollaborativeTransport.compression_enabled = True
c.CollaborativeTransport.compression_level = 6
c.CollaborativeTransport.max_message_size = 1024 * 1024  # 1MB

# Document optimization
c.CollaborativeYjs.enable_document_compression = True
c.CollaborativeYjs.snapshot_compression = True
c.CollaborativeYjs.incremental_updates = True

# Storage optimization
c.CollaborativeStorage.connection_pooling = True
c.CollaborativeStorage.max_connections = 50
c.CollaborativeStorage.connection_timeout = 30
```

### System Recovery Procedures

#### Corrupted Collaboration State Recovery

```python
#!/usr/bin/env python3
# collaboration_recovery.py

import sqlite3
import json
import shutil
from pathlib import Path
from datetime import datetime

def recover_collaboration_database(corrupted_db_path, backup_db_path=None):
    """
    Recover collaboration database from corruption
    """
    print(f"Attempting to recover {corrupted_db_path}")

    # Step 1: Try to salvage data from corrupted database
    salvaged_data = {}
    try:
        conn = sqlite3.connect(corrupted_db_path)

        # Extract what we can
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()

        for table in tables:
            table_name = table[0]
            try:
                cursor.execute(f"SELECT * FROM {table_name}")
                salvaged_data[table_name] = cursor.fetchall()
                print(f"Salvaged {len(salvaged_data[table_name])} records from {table_name}")
            except sqlite3.Error as e:
                print(f"Could not salvage {table_name}: {e}")

        conn.close()

    except sqlite3.Error as e:
        print(f"Cannot access corrupted database: {e}")

    # Step 2: Restore from backup if available
    if backup_db_path and Path(backup_db_path).exists():
        print(f"Restoring from backup: {backup_db_path}")

        # Create recovery database
        recovery_db_path = str(Path(corrupted_db_path).with_suffix('.recovered.db'))
        shutil.copy2(backup_db_path, recovery_db_path)

        # Merge salvaged data
        if salvaged_data:
            conn = sqlite3.connect(recovery_db_path)
            cursor = conn.cursor()

            # Implement merge logic based on timestamps
            for table_name, records in salvaged_data.items():
                if table_name == 'yjs_documents':
                    for record in records:
                        # Update with more recent data
                        cursor.execute("""
                            INSERT OR REPLACE INTO yjs_documents
                            VALUES (?, ?, ?, ?)
                        """, record)

            conn.commit()
            conn.close()
            print(f"Recovery database created: {recovery_db_path}")

        return recovery_db_path

    # Step 3: Create new database and restore what we can
    else:
        print("No backup available, creating new database")
        recovery_db_path = str(Path(corrupted_db_path).with_suffix('.recovered.db'))

        # Initialize new database
        from jupyter_collaboration.storage import CollaborativeStorage
        storage = CollaborativeStorage(recovery_db_path)
        storage.initialize_database()

        # Restore salvaged data
        if salvaged_data:
            conn = sqlite3.connect(recovery_db_path)
            cursor = conn.cursor()

            for table_name, records in salvaged_data.items():
                for record in records:
                    try:
                        placeholders = ','.join(['?'] * len(record))
                        cursor.execute(f"INSERT INTO {table_name} VALUES ({placeholders})", record)
                    except sqlite3.Error as e:
                        print(f"Could not restore record from {table_name}: {e}")

            conn.commit()
            conn.close()

        print(f"New database created with salvaged data: {recovery_db_path}")
        return recovery_db_path

def main():
    corrupted_db = "/data/collaboration/collaboration.db"
    backup_db = "/backup/collaboration.db"

    recovery_db = recover_collaboration_database(corrupted_db, backup_db)

    print(f"\nRecovery completed!")
    print(f"Original: {corrupted_db}")
    print(f"Recovered: {recovery_db}")
    print(f"\nTo use recovered database:")
    print(f"1. Stop Jupyter services")
    print(f"2. mv {recovery_db} {corrupted_db}")
    print(f"3. Start Jupyter services")

if __name__ == "__main__":
    main()
```

### Diagnostic Scripts

#### Comprehensive Health Check

```bash
#!/bin/bash
# jupyter_collaboration_health_check.sh

echo "=== Jupyter Collaboration Health Check ==="
echo "Timestamp: $(date)"
echo

# Check service status
echo "1. Service Status:"
systemctl is-active jupyter-notebook && echo "✓ Jupyter Notebook: Active" || echo "✗ Jupyter Notebook: Inactive"
systemctl is-active jupyterhub && echo "✓ JupyterHub: Active" || echo "✗ JupyterHub: Inactive"
echo

# Check network connectivity
echo "2. Network Connectivity:"
curl -s -o /dev/null -w "%{http_code}" http://localhost:8888/api/status | \
    grep -q "200" && echo "✓ HTTP API: Accessible" || echo "✗ HTTP API: Not accessible"

# Test WebSocket
python3 << 'EOF'
import asyncio
import websockets
import sys

async def test_websocket():
    try:
        uri = "ws://localhost:8888/api/collaboration/ws"
        async with websockets.connect(uri, timeout=5) as websocket:
            await websocket.ping()
            print("✓ WebSocket: Accessible")
            return True
    except Exception as e:
        print(f"✗ WebSocket: Not accessible ({e})")
        return False

result = asyncio.run(test_websocket())
sys.exit(0 if result else 1)
EOF

echo

# Check database connectivity
echo "3. Database Status:"
if [ -f "/data/collaboration/collaboration.db" ]; then
    sqlite3 /data/collaboration/collaboration.db "SELECT COUNT(*) FROM yjs_documents;" > /dev/null 2>&1 && \
        echo "✓ Collaboration Database: Accessible" || echo "✗ Collaboration Database: Corrupted"
else
    echo "✗ Collaboration Database: Not found"
fi
echo

# Check memory usage
echo "4. Resource Usage:"
MEMORY_USAGE=$(ps aux | grep jupyter-notebook | grep -v grep | awk '{sum += $4} END {print sum}')
echo "Memory Usage: ${MEMORY_USAGE:-0}%"
if (( $(echo "$MEMORY_USAGE > 80" | bc -l) )); then
    echo "⚠  High memory usage detected"
fi

# Check disk space
DISK_USAGE=$(df /data | tail -1 | awk '{print $5}' | sed 's/%//')
echo "Disk Usage: ${DISK_USAGE}%"
if (( DISK_USAGE > 90 )); then
    echo "⚠  Low disk space warning"
fi
echo

# Check active sessions
echo "5. Active Sessions:"
ACTIVE_SESSIONS=$(curl -s http://localhost:8888/api/collaboration/sessions | jq '. | length')
echo "Active Collaborative Sessions: ${ACTIVE_SESSIONS:-0}"

# Performance metrics
echo
echo "6. Performance Metrics:"
python3 << 'EOF'
import requests
import json

try:
    response = requests.get('http://localhost:8888/api/collaboration/metrics', timeout=5)
    if response.status_code == 200:
        metrics = response.json()
        print(f"Average Edit Latency: {metrics.get('avg_edit_latency_ms', 'N/A')}ms")
        print(f"Active Users: {metrics.get('active_users', 'N/A')}")
        print(f"Documents in Memory: {metrics.get('documents_in_memory', 'N/A')}")
        print(f"Sync Conflicts (24h): {metrics.get('sync_conflicts_24h', 'N/A')}")
    else:
        print("✗ Metrics endpoint not accessible")
except Exception as e:
    print(f"✗ Could not retrieve metrics: {e}")
EOF

echo
echo "=== Health Check Complete ==="
```

## Post-Migration Optimization

### Performance Tuning

#### Configuration Optimization Based on Usage Patterns

```python
# Analyze usage patterns and optimize accordingly
class CollaborativeUsageAnalyzer:
    def __init__(self, metrics_db_path):
        self.db_path = metrics_db_path

    def analyze_usage_patterns(self):
        """Analyze collaborative usage to recommend optimizations"""

        # Analyze session data
        session_stats = self.get_session_statistics()
        user_stats = self.get_user_statistics()
        performance_stats = self.get_performance_statistics()

        recommendations = []

        # Optimize based on session patterns
        if session_stats['avg_session_duration'] > 3600:  # 1 hour
            recommendations.append({
                'setting': 'c.CollaborativeStorage.snapshot_interval',
                'value': 1800,  # 30 minutes
                'reason': 'Long sessions benefit from frequent snapshots'
            })

        if session_stats['avg_collaborators_per_session'] > 5:
            recommendations.append({
                'setting': 'c.CollaborativeSync.batch_interval_ms',
                'value': 30,  # More frequent sync for many users
                'reason': 'High collaboration requires faster sync'
            })

        # Optimize based on performance metrics
        if performance_stats['avg_edit_latency'] > 50:  # ms
            recommendations.append({
                'setting': 'c.CollaborativeTransport.compression_enabled',
                'value': True,
                'reason': 'High latency suggests network optimization needed'
            })

        return recommendations
```

#### Automated Performance Tuning

```python
# Automated performance optimization script
def optimize_collaborative_performance():
    """
    Automatically optimize collaboration settings based on observed performance
    """

    # Collect current performance metrics
    current_metrics = collect_performance_metrics()

    # Generate optimization recommendations
    optimizer = PerformanceOptimizer(current_metrics)
    recommendations = optimizer.generate_recommendations()

    # Apply safe optimizations automatically
    safe_optimizations = [r for r in recommendations if r['safety_level'] == 'safe']

    config_updates = {}
    for opt in safe_optimizations:
        config_updates[opt['setting']] = opt['value']

    # Update configuration
    update_jupyter_config(config_updates)

    # Schedule restart during maintenance window
    schedule_service_restart()

    # Log optimization actions
    log_optimization_actions(recommendations, config_updates)

# Schedule optimization to run weekly
def schedule_performance_optimization():
    """Schedule regular performance optimization"""
    import cron

    # Run every Sunday at 2 AM
    cron.add_job(optimize_collaborative_performance,
                 trigger='cron', day_of_week=6, hour=2)
```

### Capacity Planning

#### Growth Projection and Scaling

```python
# Capacity planning based on growth trends
class CapacityPlanner:
    def __init__(self, historical_data):
        self.data = historical_data

    def project_capacity_needs(self, months_ahead=12):
        """Project infrastructure needs based on growth trends"""

        # Analyze growth trends
        user_growth_rate = self.calculate_growth_rate('active_users')
        session_growth_rate = self.calculate_growth_rate('collaborative_sessions')

        # Project future needs
        projected_users = self.current_users * (1 + user_growth_rate) ** months_ahead
        projected_sessions = self.current_sessions * (1 + session_growth_rate) ** months_ahead

        # Calculate infrastructure requirements
        cpu_cores_needed = projected_sessions * 0.1  # 0.1 core per session
        memory_gb_needed = projected_users * 0.5     # 500MB per user
        storage_gb_needed = projected_users * 2      # 2GB per user

        return {
            'projected_users': int(projected_users),
            'projected_sessions': int(projected_sessions),
            'cpu_cores_needed': int(cpu_cores_needed),
            'memory_gb_needed': int(memory_gb_needed),
            'storage_gb_needed': int(storage_gb_needed),
            'recommended_servers': int(cpu_cores_needed / 8),  # 8 cores per server
        }

    def generate_scaling_timeline(self):
        """Generate timeline for infrastructure scaling"""

        timeline = []

        for month in range(1, 13):
            needs = self.project_capacity_needs(month)

            if needs['recommended_servers'] > self.current_servers:
                timeline.append({
                    'month': month,
                    'action': 'scale_up',
                    'servers_to_add': needs['recommended_servers'] - self.current_servers,
                    'estimated_cost': self.calculate_scaling_cost(needs)
                })

        return timeline
```

### Advanced Configuration

#### Multi-Tenant Optimization

```python
# Advanced configuration for multi-tenant environments
c.CollaborativeTenancy.enabled = True
c.CollaborativeTenancy.isolation_mode = 'organization'  # or 'department', 'project'

# Per-tenant resource limits
c.CollaborativeTenancy.tenant_limits = {
    'max_concurrent_sessions_per_tenant': 100,
    'max_documents_per_tenant': 1000,
    'storage_quota_gb_per_tenant': 50,
    'bandwidth_limit_mbps_per_tenant': 10,
}

# Per-tenant customization
c.CollaborativeTenancy.tenant_config = {
    'engineering': {
        'max_collaborators_per_document': 20,
        'enable_advanced_features': True,
        'custom_theme': 'engineering_theme',
    },
    'marketing': {
        'max_collaborators_per_document': 5,
        'enable_advanced_features': False,
        'custom_theme': 'marketing_theme',
    }
}
```

#### Global Load Balancing

```python
# Global load balancing for worldwide deployments
c.CollaborativeLoadBalancing.enabled = True
c.CollaborativeLoadBalancing.strategy = 'geographic'

# Regional server configuration
c.CollaborativeLoadBalancing.regions = {
    'us-east': {
        'servers': ['us-east-1.jupyter.com', 'us-east-2.jupyter.com'],
        'capacity': 1000,
        'latency_zones': ['north_america', 'south_america'],
    },
    'eu-west': {
        'servers': ['eu-west-1.jupyter.com', 'eu-west-2.jupyter.com'],
        'capacity': 800,
        'latency_zones': ['europe', 'africa'],
    },
    'asia-pacific': {
        'servers': ['asia-1.jupyter.com', 'asia-2.jupyter.com'],
        'capacity': 600,
        'latency_zones': ['asia', 'oceania'],
    }
}

# Cross-region synchronization
c.CollaborativeSync.cross_region_enabled = True
c.CollaborativeSync.cross_region_sync_interval = 200  # ms
c.CollaborativeSync.region_affinity_enabled = True
```

### Success Metrics and KPI Tracking

#### Post-Migration Success Dashboard

```python
# KPI tracking and dashboard configuration
SUCCESS_METRICS = {
    'adoption_metrics': {
        'collaborative_session_percentage': {
            'target': 60,  # 60% of sessions should be collaborative
            'measurement': 'collaborative_sessions / total_sessions * 100'
        },
        'user_adoption_rate': {
            'target': 75,  # 75% of users should try collaboration
            'measurement': 'users_with_collab_sessions / total_users * 100'
        }
    },

    'performance_metrics': {
        'edit_latency_95th_percentile': {
            'target': 100,  # milliseconds
            'measurement': 'percentile(edit_latency, 95)'
        },
        'system_availability': {
            'target': 99.5,  # percentage
            'measurement': 'uptime / total_time * 100'
        }
    },

    'business_metrics': {
        'productivity_improvement': {
            'target': 20,  # 20% improvement
            'measurement': 'collaborative_task_completion_time vs baseline'
        },
        'collaboration_frequency': {
            'target': 40,  # 40% of work should be collaborative
            'measurement': 'collaborative_hours / total_work_hours * 100'
        }
    },

    'user_satisfaction': {
        'satisfaction_score': {
            'target': 4.2,  # out of 5
            'measurement': 'average(user_satisfaction_surveys)'
        },
        'feature_usefulness': {
            'target': 4.0,  # out of 5
            'measurement': 'average(feature_usefulness_ratings)'
        }
    }
}
```

#### Continuous Improvement Process

```python
# Automated continuous improvement system
class ContinuousImprovement:
    def __init__(self):
        self.metrics_collector = MetricsCollector()
        self.analyzer = PerformanceAnalyzer()
        self.optimizer = ConfigurationOptimizer()

    def run_monthly_analysis(self):
        """Monthly analysis and optimization cycle"""

        # Collect metrics for the past month
        monthly_metrics = self.metrics_collector.collect_monthly_data()

        # Analyze performance trends
        trends = self.analyzer.analyze_trends(monthly_metrics)

        # Identify improvement opportunities
        opportunities = self.analyzer.identify_opportunities(trends)

        # Generate optimization recommendations
        recommendations = self.optimizer.generate_recommendations(opportunities)

        # Create improvement plan
        improvement_plan = self.create_improvement_plan(recommendations)

        # Schedule implementation during maintenance windows
        self.schedule_improvements(improvement_plan)

        # Generate report for stakeholders
        self.generate_improvement_report(monthly_metrics, trends, improvement_plan)

    def create_improvement_plan(self, recommendations):
        """Create prioritized improvement plan"""

        # Prioritize by impact and effort
        prioritized = sorted(recommendations,
                           key=lambda x: x['impact'] / x['effort'],
                           reverse=True)

        plan = {
            'quick_wins': [r for r in prioritized if r['effort'] <= 2 and r['impact'] >= 3],
            'major_projects': [r for r in prioritized if r['effort'] > 5 and r['impact'] >= 4],
            'maintenance': [r for r in prioritized if r['type'] == 'maintenance']
        }

        return plan
```

---

This migration guide provides comprehensive coverage of transitioning from single-user to collaborative Jupyter Notebook environments. It addresses all the key requirements from the summary including backward compatibility, optional features, rollback procedures, and common migration scenarios.

The guide emphasizes that collaboration features are completely optional and that single-user mode continues to work identically to previous versions, ensuring organizations can adopt collaborative features at their own pace without risk to existing workflows.
