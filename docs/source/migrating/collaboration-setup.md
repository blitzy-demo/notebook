# Collaboration Setup Guide

This guide provides comprehensive instructions for enabling real-time collaborative editing features in existing Jupyter Notebook v7 deployments. The collaboration system is built on the Yjs CRDT framework and provides conflict-free multi-user editing with sub-100ms latency.

## Overview

Jupyter Notebook v7 introduces comprehensive real-time collaborative editing capabilities that enable:

- **Multi-user simultaneous editing** with live synchronization
- **Visual presence awareness** showing active collaborators and their cursor positions  
- **Cell-level locking mechanism** to prevent editing conflicts
- **Fine-grained permissions system** supporting view-only, edit, and admin roles
- **Integrated comment and review system** for collaborative discussion
- **Seamless JupyterHub integration** for enterprise deployments
- **Graceful degradation** to single-user mode when collaboration services are unavailable

The collaborative features are designed to maintain **full backward compatibility** with existing notebook functionality and the .ipynb file format.

## Prerequisites

### System Requirements

- **Jupyter Notebook v7.0+** with JupyterLab v4.5+ components
- **Python 3.9+** for async WebSocket handling
- **Node.js 16+** for building frontend collaboration components
- **WebSocket-capable HTTP server** (nginx, Apache, or cloud load balancer)

### Required Dependencies

The collaboration system requires these additional packages beyond the standard Notebook installation:

```bash
# Core Yjs collaboration dependencies
pip install "yjs>=13.5.40" "y-websocket>=1.4.0" "y-protocols>=1.0.5" "lib0>=0.2.0"

# Server-side CRDT implementation  
pip install "pycrdt>=0.3.0"

# JupyterLab collaboration reference components
pip install "@jupyterlab/collaboration>=4.5.0"
```

### Network Requirements

- **WebSocket support** on all network infrastructure (proxies, load balancers, firewalls)
- **TLS termination** configured for secure WebSocket connections (WSS)
- **Session affinity** (sticky sessions) for WebSocket connections in multi-server deployments
- **Port accessibility** for the y-websocket service (default: same port as Jupyter Server)

## Architecture Options

Jupyter Notebook v7 supports multiple deployment patterns for collaborative features:

### Integrated Deployment (Recommended for Development)

The collaboration WebSocket handler runs as part of the main Jupyter Server process:

```python
# jupyter_notebook_config.py
c.NotebookApp.collaborative = True
c.NotebookApp.websocket_handler = 'notebook.collab.handlers.YjsWebSocketHandler'
c.NotebookApp.allow_origin = '*'  # Configure appropriately for production
```

**Advantages:**
- Simplified configuration with single process
- Shared authentication context
- Single TLS certificate required
- Optimal for development and small-scale deployments

**Limitations:**
- Single point of failure
- Resource contention between notebook and collaboration services
- Limited scaling flexibility

### Side-car Deployment (Recommended for Production)

Dedicated y-websocket service container alongside Jupyter Server:

```yaml
# docker-compose.yml
version: '3.8'
services:
  jupyter:
    image: jupyter/notebook:7.0
    environment:
      - COLLAB_WEBSOCKET_URL=ws://collab-service:1234
    depends_on:
      - collab-service
    
  collab-service:
    image: jupyter/y-websocket:latest
    environment:
      - YPERSISTENCE_PATH=/data/yjs-documents
    volumes:
      - ./collab-data:/data
    ports:
      - "1234:1234"
```

**Advantages:**
- Independent scaling and resource allocation
- Fault isolation between services
- Optimal for high-concurrency scenarios
- Enhanced security through service separation

**Configuration Requirements:**
- Shared authentication token validation
- Network connectivity configuration
- Coordinated health monitoring

## Configuration Steps

### Step 1: Enable Collaboration Features

Add collaboration configuration to your Jupyter configuration file:

```python
# jupyter_notebook_config.py

# Enable collaborative editing
c.NotebookApp.collaborative = True

# Configure Yjs document provider
c.YjsNotebookProvider.document_cleanup_delay = 300  # 5 minutes
c.YjsNotebookProvider.max_document_size = 50 * 1024 * 1024  # 50MB
c.YjsNotebookProvider.awareness_timeout = 30  # 30 seconds

# Configure WebSocket service
c.YjsWebSocketHandler.port = 8888  # Same as notebook server (integrated mode)
c.YjsWebSocketHandler.max_connections_per_document = 50
c.YjsWebSocketHandler.message_rate_limit = 100  # messages per second

# Performance optimizations
c.CollabPerformanceManager.update_throttle_ms = 50
c.CollabPerformanceManager.memory_cleanup_interval = 600  # 10 minutes
c.CollabPerformanceManager.max_memory_usage_mb = 1024  # 1GB per document
```

### Step 2: Configure Authentication and Permissions

For JupyterHub deployments, extend the authentication configuration:

```python
# jupyterhub_config.py

# Enable collaboration with role-based permissions
c.JupyterHub.services.append({
    'name': 'collaboration',
    'url': 'http://127.0.0.1:8889',
    'command': ['python', '-m', 'notebook.collab.service'],
    'environment': {
        'JUPYTERHUB_API_TOKEN': '{api_token}',
        'COLLAB_PERMISSIONS_BACKEND': 'jupyterhub',
    }
})

# Configure collaboration permissions
c.CollabPermissionManager.default_role = 'edit'  # 'view', 'edit', or 'admin'
c.CollabPermissionManager.role_inheritance = True
c.CollabPermissionManager.permission_cache_ttl = 300  # 5 minutes
```

Create a permissions configuration file:

```json
# collab_permissions.json
{
  "default_policy": {
    "role": "edit",
    "permissions": {
      "read": true,
      "write": true,
      "execute": true,
      "comment": true
    }
  },
  "role_definitions": {
    "view": {
      "read": true,
      "write": false,
      "execute": false,
      "comment": true
    },
    "edit": {
      "read": true,
      "write": true,
      "execute": true,
      "comment": true
    },
    "admin": {
      "read": true,
      "write": true,
      "execute": true,
      "comment": true,
      "manage_permissions": true,
      "manage_locks": true
    }
  }
}
```

### Step 3: Configure WebSocket Service

#### For Integrated Deployment

```python
# jupyter_notebook_config.py

# WebSocket configuration
c.NotebookApp.websocket_compression_options = {
    'compression_level': 6,
    'mem_level': 8
}

c.NotebookApp.websocket_ping_interval = 20
c.NotebookApp.websocket_ping_timeout = 30

# Yjs-specific WebSocket settings
c.YjsWebSocketHandler.compression = True
c.YjsWebSocketHandler.binary_messages = True
c.YjsWebSocketHandler.heartbeat_interval = 15
```

#### For Side-car Deployment

Create a separate y-websocket service configuration:

```javascript
// y-websocket-config.js
const Y = require('yjs')
const { WebSocketProvider } = require('y-websocket')
const { setupWSConnection } = require('./utils')

const host = process.env.YWSS_HOST || 'localhost'
const port = process.env.YWSS_PORT || 1234

const wss = new WebSocket.Server({ 
  host, 
  port,
  perMessageDeflate: {
    zlibDeflateOptions: {
      level: 6,
      threshold: 1024,
    },
  }
})

wss.on('connection', (ws, req) => {
  setupWSConnection(ws, req, {
    // Authentication callback
    authenticate: async (token) => {
      return await validateJupyterToken(token)
    },
    // Permission check callback  
    authorize: async (user, docId, operation) => {
      return await checkUserPermissions(user, docId, operation)
    }
  })
})

console.log(`Y-WebSocket server running on ws://${host}:${port}`)
```

### Step 4: Environment Variable Configuration

Configure collaboration behavior through environment variables:

```bash
# Enable/disable collaboration features
export COLLAB_ENABLED=true          # Enable collaboration (default: true)
export COLLAB_DISABLED=false        # Explicit disable flag for graceful degradation

# Performance tuning
export COLLAB_MAX_USERS_PER_DOCUMENT=50        # Concurrent users per notebook
export COLLAB_UPDATE_LATENCY_TARGET=100        # Target latency in milliseconds
export COLLAB_MEMORY_LIMIT_MB=1024             # Memory limit per document
export COLLAB_CLEANUP_INTERVAL=300             # Document cleanup interval in seconds

# WebSocket configuration
export COLLAB_WEBSOCKET_URL=ws://localhost:8888/api/yjs
export COLLAB_WEBSOCKET_TIMEOUT=30000          # Connection timeout in milliseconds
export COLLAB_RECONNECT_INTERVAL=5000          # Reconnection interval

# Security settings
export COLLAB_REQUIRE_AUTH=true                # Require authentication for collaboration
export COLLAB_ENFORCE_PERMISSIONS=true         # Enable permission checking
export COLLAB_AUDIT_LOG=true                   # Enable collaboration audit logging

# Development/debugging
export COLLAB_DEBUG=false                      # Enable debug logging
export COLLAB_METRICS_ENABLED=true             # Enable performance metrics
```

## Graceful Degradation Setup

The collaboration system is designed to gracefully degrade to single-user mode when collaboration services are unavailable. This ensures existing deployments continue to function without interruption.

### Automatic Fallback Configuration

```python
# jupyter_notebook_config.py

# Enable graceful degradation
c.NotebookApp.collab_fallback_enabled = True
c.NotebookApp.collab_fallback_timeout = 10  # seconds to wait for collab service

# Fallback behavior
c.NotebookApp.collab_fallback_mode = 'single_user'  # 'single_user' or 'read_only'
c.NotebookApp.collab_fallback_notification = True  # Notify users of fallback mode
```

### Environment-based Disable

For environments where collaboration should be completely disabled:

```bash
# Disable collaboration features entirely
export COLLAB_DISABLED=true

# Alternative using configuration
export JUPYTER_CONFIG_DIR=/path/to/single-user-config
```

With `COLLAB_DISABLED=true`, the system will:
- Skip loading collaboration-related JavaScript modules
- Disable WebSocket endpoints for collaboration
- Hide collaboration UI elements
- Maintain full single-user notebook functionality
- Preserve all existing keyboard shortcuts and behaviors

### Mixed Environment Support

For deployments serving both collaborative and single-user workloads:

```python
# jupyter_notebook_config.py

# Dynamic collaboration enablement based on request headers
c.NotebookApp.collab_detection_header = 'X-Jupyter-Collab'
c.NotebookApp.collab_detection_values = ['enabled', 'true', '1']

# User-specific collaboration preferences
c.NotebookApp.collab_user_preference_key = 'collaboration_enabled'
c.NotebookApp.collab_respect_user_preference = True
```

## TLS and Proxy Configuration

### nginx Configuration

```nginx
# nginx.conf
upstream jupyter {
    server 127.0.0.1:8888;
}

upstream collaboration {
    server 127.0.0.1:1234;
}

server {
    listen 443 ssl http2;
    server_name jupyter.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    # Main Jupyter Notebook application
    location / {
        proxy_pass http://jupyter;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket support for notebooks
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
    
    # Collaboration WebSocket endpoint
    location /api/yjs {
        proxy_pass http://collaboration;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Collaboration-specific headers
        proxy_set_header X-Jupyter-Collab enabled;
        proxy_set_header X-User-Token $http_authorization;
        
        # Performance optimizations
        proxy_buffering off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
        
        # Session affinity (sticky sessions)
        ip_hash;
    }
}
```

### Apache Configuration

```apache
# apache.conf
<VirtualHost *:443>
    ServerName jupyter.example.com
    
    SSLEngine on
    SSLCertificateFile /path/to/cert.pem
    SSLCertificateKeyFile /path/to/key.pem
    
    # Enable WebSocket module
    LoadModule proxy_wstunnel_module modules/mod_proxy_wstunnel.so
    
    # Collaboration WebSocket proxying
    ProxyPass /api/yjs ws://127.0.0.1:1234/
    ProxyPassReverse /api/yjs ws://127.0.0.1:1234/
    
    # Main application proxying
    ProxyPass / http://127.0.0.1:8888/
    ProxyPassReverse / http://127.0.0.1:8888/
    
    # WebSocket headers
    ProxyPreserveHost On
    ProxyVia On
    ProxyRequests Off
    
    # Session stickiness
    Header add Set-Cookie "ROUTEID=.%{BALANCER_WORKER_ROUTE}e; path=/"
</VirtualHost>
```

### Kubernetes Ingress Configuration

```yaml
# kubernetes-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: jupyter-collaboration
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/websocket-services: "jupyter-collab-service"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/session-affinity: "cookie"
    nginx.ingress.kubernetes.io/session-affinity-mode: "persistent"
spec:
  tls:
  - hosts:
    - jupyter.example.com
    secretName: jupyter-tls
  rules:
  - host: jupyter.example.com
    http:
      paths:
      - path: /api/yjs
        pathType: Prefix
        backend:
          service:
            name: jupyter-collab-service
            port:
              number: 1234
      - path: /
        pathType: Prefix
        backend:
          service:
            name: jupyter-service
            port:
              number: 8888
```

## Performance Tuning

### System Resource Optimization

```python
# jupyter_notebook_config.py

# Memory management
c.CollabMemoryManager.max_document_cache_size = 100  # Maximum cached documents
c.CollabMemoryManager.document_eviction_policy = 'lru'  # 'lru' or 'ttl'
c.CollabMemoryManager.memory_pressure_threshold = 0.8  # 80% memory usage trigger

# CPU optimization
c.CollabCPUManager.update_batching_enabled = True
c.CollabCPUManager.update_batch_size = 10
c.CollabCPUManager.update_batch_timeout_ms = 50

# Network optimization
c.CollabNetworkManager.compression_enabled = True
c.CollabNetworkManager.compression_level = 6
c.CollabNetworkManager.binary_protocol = True
c.CollabNetworkManager.message_deduplication = True
```

### Database and Storage Configuration

For persistent collaboration history and comments:

```python
# jupyter_notebook_config.py

# Collaboration persistence
c.CollabPersistence.backend = 'sqlite'  # 'sqlite', 'postgresql', or 'memory'
c.CollabPersistence.database_url = 'sqlite:////data/collaboration.db'
c.CollabPersistence.history_retention_days = 30
c.CollabPersistence.comment_retention_days = 90

# Yjs document persistence
c.YjsPersistence.provider = 'leveldb'  # 'leveldb', 'redis', or 'filesystem'
c.YjsPersistence.storage_path = '/data/yjs-documents'
c.YjsPersistence.compression = True
c.YjsPersistence.cleanup_interval = 3600  # 1 hour
```

### Monitoring and Metrics

```python
# jupyter_notebook_config.py

# Enable collaboration metrics
c.CollabMetrics.enabled = True
c.CollabMetrics.prometheus_port = 9090
c.CollabMetrics.statsd_host = 'localhost'
c.CollabMetrics.statsd_port = 8125

# Performance tracking
c.CollabMetrics.track_latency = True
c.CollabMetrics.track_memory_usage = True
c.CollabMetrics.track_connection_count = True
c.CollabMetrics.track_document_operations = True
```

Key metrics to monitor:
- **Collaboration latency**: Target <100ms for edit operations
- **WebSocket connection stability**: >99.9% uptime
- **Memory usage**: <20% increase over single-user mode
- **Concurrent users**: Up to 50 users per notebook
- **CRDT operation rate**: Operations per second per document

## Security Configuration

### Authentication Integration

```python
# jupyter_notebook_config.py

# JupyterHub integration
c.CollabAuth.hub_api_url = 'http://jupyterhub:8000/hub/api'
c.CollabAuth.hub_token_validation = True
c.CollabAuth.require_authentication = True

# Custom authentication
c.CollabAuth.authenticator_class = 'notebook.collab.auth.JupyterHubAuthenticator'
c.CollabAuth.token_header = 'Authorization'
c.CollabAuth.token_validation_url = '/hub/api/user'
```

### Permission System Setup

```python
# jupyter_notebook_config.py

# Role-based access control
c.CollabPermissions.enable_rbac = True
c.CollabPermissions.default_permissions = {
    'read': True,
    'write': True,
    'execute': True,
    'comment': True
}

# Permission enforcement
c.CollabPermissions.server_side_validation = True
c.CollabPermissions.client_side_filtering = True
c.CollabPermissions.audit_permission_changes = True
```

### Network Security

```python
# jupyter_notebook_config.py

# CORS configuration for collaboration
c.NotebookApp.allow_origin = 'https://jupyter.example.com'
c.NotebookApp.allow_credentials = True
c.NotebookApp.allow_origin_pat = r'https://.*\.example\.com'

# WebSocket security
c.YjsWebSocketHandler.check_origin = True
c.YjsWebSocketHandler.allow_origin = 'https://jupyter.example.com'
c.YjsWebSocketHandler.require_auth = True
c.YjsWebSocketHandler.validate_tokens = True
```

## Validation and Testing

### Installation Verification

Test that collaboration dependencies are correctly installed:

```bash
# Check Python dependencies
python -c "import yjs, pycrdt; print('Collaboration dependencies OK')"

# Check JavaScript dependencies  
jupyter lab build --check
jupyter notebook --version

# Verify collaboration features are available
python -c "
from notebook.collab.provider import YjsNotebookProvider
from notebook.collab.handlers import YjsWebSocketHandler
print('Collaboration modules loaded successfully')
"
```

### Configuration Testing

Validate your collaboration configuration:

```python
# test_collab_config.py
import asyncio
from notebook.collab.tests import CollaborationTestSuite

async def test_collaboration():
    test_suite = CollaborationTestSuite()
    
    # Test basic connectivity
    assert await test_suite.test_websocket_connection()
    
    # Test authentication
    assert await test_suite.test_authentication()
    
    # Test permissions
    assert await test_suite.test_permission_enforcement()
    
    # Test multi-user editing
    assert await test_suite.test_collaborative_editing()
    
    print("All collaboration tests passed!")

if __name__ == "__main__":
    asyncio.run(test_collaboration())
```

### Performance Validation

Verify that performance targets are met:

```bash
# Performance benchmark script
python -m notebook.collab.benchmark \
    --users 5 \
    --duration 300 \
    --notebook test_notebook.ipynb \
    --target-latency 100

# Expected output:
# Average edit latency: 85ms ✓
# Memory overhead: 15% ✓  
# Connection stability: 99.9% ✓
# Concurrent users supported: 5/5 ✓
```

## Troubleshooting

### Common Issues

#### WebSocket Connection Failures

**Symptom**: Collaboration features not working, users see "Collaboration Unavailable" message

**Diagnosis**:
```bash
# Check WebSocket endpoint
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: test" \
    http://localhost:8888/api/yjs

# Check collaboration service logs
journalctl -u jupyter-collaboration -f
```

**Solutions**:
- Verify proxy configuration supports WebSocket upgrades
- Check firewall rules allow WebSocket connections
- Ensure TLS configuration is correct for WSS connections
- Validate session affinity configuration

#### Permission Denied Errors

**Symptom**: Users cannot edit notebooks, see read-only mode unexpectedly

**Diagnosis**:
```python
# Check user permissions
from notebook.collab.permissions import CollabPermissionManager
pm = CollabPermissionManager()
permissions = pm.get_user_permissions(username, notebook_path)
print(f"User permissions: {permissions}")
```

**Solutions**:
- Verify JupyterHub authentication tokens are valid
- Check permission configuration file syntax
- Ensure permission cache is not stale
- Validate user role assignments

#### High Latency or Poor Performance

**Symptom**: Edit operations take >100ms, sluggish collaboration

**Diagnosis**:
```bash
# Check collaboration metrics
curl http://localhost:9090/metrics | grep collab_

# Monitor resource usage
top -p $(pgrep -f jupyter)
```

**Solutions**:
- Increase memory allocation for collaboration service
- Enable compression for WebSocket messages
- Optimize database queries for permissions
- Consider side-car deployment for better resource isolation

### Debug Mode

Enable comprehensive debug logging:

```python
# jupyter_notebook_config.py
c.Application.log_level = 'DEBUG'
c.CollabLogger.level = 'DEBUG'
c.CollabLogger.log_websocket_messages = True
c.CollabLogger.log_yjs_operations = True
c.CollabLogger.log_permission_checks = True
```

### Health Check Endpoints

Monitor collaboration service health:

```python
# Health check script
import requests
import json

def check_collaboration_health():
    try:
        # Check main service
        response = requests.get('http://localhost:8888/api/status')
        assert response.status_code == 200
        
        # Check collaboration service
        collab_response = requests.get('http://localhost:8888/api/yjs/health')
        assert collab_response.status_code == 200
        
        # Check metrics endpoint
        metrics_response = requests.get('http://localhost:9090/metrics')
        assert 'collab_connections_active' in metrics_response.text
        
        print("✓ All collaboration services healthy")
        return True
        
    except Exception as e:
        print(f"✗ Health check failed: {e}")
        return False

if __name__ == "__main__":
    check_collaboration_health()
```

## Migration Checklist

Use this checklist to ensure successful collaboration setup:

### Pre-Migration
- [ ] **Backup existing notebooks** and configuration files
- [ ] **Verify system requirements** (Python 3.9+, Node.js 16+)
- [ ] **Test in staging environment** before production deployment
- [ ] **Document current performance baselines** for comparison

### Installation
- [ ] **Install collaboration dependencies** (yjs, pycrdt, etc.)
- [ ] **Update Jupyter Notebook** to v7.0+
- [ ] **Build frontend assets** with collaboration features
- [ ] **Verify module imports** work correctly

### Configuration  
- [ ] **Configure collaboration settings** in jupyter_notebook_config.py
- [ ] **Set up authentication integration** with JupyterHub
- [ ] **Configure WebSocket service** (integrated or side-car)
- [ ] **Set environment variables** for feature flags

### Network Setup
- [ ] **Configure proxy/load balancer** for WebSocket support
- [ ] **Set up TLS termination** for secure connections
- [ ] **Configure session affinity** for multi-server deployments
- [ ] **Test WebSocket connectivity** from client networks

### Security
- [ ] **Configure authentication** and token validation
- [ ] **Set up permission system** with appropriate roles
- [ ] **Configure CORS** for cross-origin requests
- [ ] **Enable audit logging** for collaboration activities

### Testing
- [ ] **Run installation verification** tests
- [ ] **Test multi-user editing** with sample notebooks
- [ ] **Validate performance** meets <100ms latency target
- [ ] **Test graceful degradation** with COLLAB_DISABLED=true

### Production
- [ ] **Monitor collaboration metrics** (latency, connections, errors)
- [ ] **Set up alerting** for collaboration service health
- [ ] **Document troubleshooting procedures** for operators
- [ ] **Train users** on new collaborative features

### Post-Migration
- [ ] **Monitor system performance** for any degradation
- [ ] **Collect user feedback** on collaboration experience
- [ ] **Review security logs** for any anomalies
- [ ] **Update documentation** with lessons learned

## Conclusion

Following this guide enables comprehensive real-time collaborative editing in Jupyter Notebook v7 while maintaining backward compatibility and performance. The collaboration system provides enterprise-grade features including multi-user editing, presence awareness, permissions, and graceful degradation.

Key benefits of the collaboration setup:
- **Zero-latency editing** with conflict-free synchronization via Yjs CRDT
- **Visual collaboration** with real-time presence and cursor tracking
- **Secure permissions** with role-based access control
- **Production scalability** supporting 50+ concurrent users per notebook
- **Seamless integration** with existing JupyterHub deployments

For additional support and advanced configuration options, refer to the [Jupyter Collaboration Documentation](https://jupyter-collaboration.readthedocs.io/) and the [Yjs Documentation](https://docs.yjs.dev/).

---

*This guide covers Jupyter Notebook v7.0+ collaboration features. For older versions, see the [Legacy Collaboration Guide](legacy-collaboration.md).*