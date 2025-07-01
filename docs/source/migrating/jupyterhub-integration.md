# JupyterHub Integration Migration Guide

This guide provides comprehensive instructions for JupyterHub administrators to implement collaborative editing capabilities in Jupyter Notebook v7. The integration enables real-time multi-user collaboration while maintaining security, scalability, and enterprise-grade deployment patterns.

## Overview

Jupyter Notebook v7 collaborative editing extends the familiar single-user notebook experience with enterprise-grade multi-user capabilities built on conflict-free replicated data types (CRDTs) using the Yjs framework. This integration preserves existing JupyterHub authentication patterns while adding granular permission controls and real-time synchronization.

### Key Capabilities

- **Real-time Collaborative Editing**: Multiple users edit notebooks simultaneously with sub-100ms synchronization
- **Role-based Permissions**: View-only, edit, and admin roles integrated with JupyterHub authentication
- **Cell-level Locking**: Distributed locking prevents editing conflicts while enabling parallel work
- **User Presence Awareness**: Visual indicators show collaborator cursor positions and active cells
- **Comment and Review System**: Threaded discussions and feedback directly within notebook cells
- **Comprehensive Change History**: Track individual contributions and maintain audit trails

### Architecture Overview

The collaborative system operates through several integrated components:

- **YjsNotebookProvider**: Client-side CRDT document management wrapping the notebook model
- **YjsWebSocketHandler**: Server-side extension handling real-time synchronization via WebSocket
- **CollabPermissionManager**: Role-based access control integrated with JupyterHub tokens
- **Awareness Protocol**: Real-time user presence and cursor sharing system
- **Lock Coordination Service**: Distributed cell-level editing locks with timeout management

## Prerequisites

### Software Requirements

**Core Dependencies:**
- JupyterHub 4.0.0 or higher
- Jupyter Notebook 7.0.0 or higher
- Python 3.9 or higher
- Node.js 18 or higher (for extension building)

**Collaboration Dependencies:**
- `yjs>=13.5.40` - Core CRDT implementation
- `y-websocket>=1.4.0` - WebSocket provider for Yjs
- `pycrdt>=0.3.0` - Python Yjs implementation for server-side handling
- `jupyter-collaboration>=2.0.0` - Collaboration extension framework

### Infrastructure Requirements

**Network Configuration:**
- WebSocket connections must be supported through your load balancer/proxy
- TLS termination required for secure collaborative sessions
- Session affinity (sticky sessions) required for WebSocket connections

**Resource Planning Guidelines:**
- **Memory**: Additional 50MB per active collaborative notebook session
- **CPU**: 2-3x overhead during high-frequency collaborative editing periods  
- **Network**: ~10KB/s additional bandwidth per active collaborator
- **Storage**: No additional persistent storage (collaboration metadata is ephemeral)

## Migration Steps

### Step 1: Install Collaboration Components

#### Install Server-side Components

```bash
# Install core collaboration packages
pip install jupyter-collaboration>=2.0.0 pycrdt>=0.3.0

# Install Jupyter Notebook v7 with collaboration support
pip install notebook>=7.0.0

# Verify installation
jupyter server extension list
```

Expected output should include:
```
jupyter_collaboration enabled
```

#### Install Client-side Components (if building from source)

```bash
# Install Node.js dependencies for collaborative features
npm install yjs@^13.5.40 y-websocket@^1.4.0 y-protocols@^1.0.5

# Build collaborative extensions
jupyter labextension develop packages/notebook-extension --overwrite
jupyter labextension list
```

### Step 2: Configure JupyterHub Authentication Integration

#### OAuth2 Token Extension for Role-based Permissions

Extend your JupyterHub configuration to include collaboration role claims in authentication tokens:

**jupyterhub_config.py:**

```python
import json
from jupyterhub.auth import Authenticator
from jupyter_collaboration.handlers import CollabPermissionManager

# Configure OAuth scopes for collaboration permissions
c.JupyterHub.oauth_scopes = [
    'read:user',
    'user:email', 
    'notebook:read',
    'notebook:write',
    'notebook:admin'
]

# Custom authenticator with collaboration role mapping
class CollaborativeAuthenticator(Authenticator):
    """Authenticator that includes collaboration role claims in tokens."""
    
    async def authenticate(self, handler, data):
        # Your existing authentication logic here
        user_info = await super().authenticate(handler, data)
        
        if user_info:
            # Map user to collaboration roles based on your logic
            # Example: Admin users get 'admin', instructors get 'edit', students get 'view'
            user_role = self.determine_collaboration_role(user_info['name'])
            
            # Add collaboration claims to the token
            user_info['collab_role'] = user_role
            user_info['collab_permissions'] = self.get_role_permissions(user_role)
            
        return user_info
    
    def determine_collaboration_role(self, username):
        """Determine collaboration role based on username or group membership."""
        # Example implementation - customize based on your user management
        if username in self.admin_users:
            return 'admin'
        elif username in self.instructor_users:
            return 'edit'
        else:
            return 'view'
    
    def get_role_permissions(self, role):
        """Get permissions list for a given role."""
        permissions = {
            'admin': ['read', 'write', 'execute', 'manage_permissions', 'manage_comments'],
            'edit': ['read', 'write', 'execute', 'comment'],
            'view': ['read', 'comment']
        }
        return permissions.get(role, ['read'])

# Use the collaborative authenticator
c.JupyterHub.authenticator_class = CollaborativeAuthenticator

# Configure admin users (customize based on your environment)
c.CollaborativeAuthenticator.admin_users = {'admin', 'instructor1', 'instructor2'}
c.CollaborativeAuthenticator.instructor_users = {'ta1', 'ta2', 'researcher1'}
```

#### Token Validation Configuration

Configure Jupyter Server to validate JupyterHub tokens with collaboration claims:

**jupyter_server_config.py:**

```python
# Enable collaboration extension
c.ServerApp.jpserver_extensions = {
    'jupyter_collaboration': True,
    'notebook': True
}

# Configure collaboration settings
c.LabServerApp.collaborative = True

# Custom token validation for collaboration permissions
c.JupyterHub.services = [
    {
        'name': 'notebook-collaboration',
        'url': 'http://127.0.0.1:8888',
        'command': [
            'jupyter', 'notebook',
            '--ServerApp.token=""',
            '--ServerApp.disable_check_xsrf=True',
            '--ServerApp.allow_origin="*"',
            '--LabServerApp.collaborative=True'
        ],
        'environment': {
            'JUPYTERHUB_SERVICE_PREFIX': '/services/notebook-collaboration/',
            'COLLAB_ENABLED': 'true',
            'COLLAB_AUTH_MODE': 'jupyterhub'
        }
    }
]
```

### Step 3: Configure Spawner for Collaboration Support

#### Docker Spawner Configuration

If using Docker spawner, configure containers to support collaborative features:

**jupyterhub_config.py:**

```python
from dockerspawner import DockerSpawner

class CollaborativeDockerSpawner(DockerSpawner):
    """Docker spawner with collaboration support."""
    
    def get_env(self):
        env = super().get_env()
        
        # Enable collaboration features
        env.update({
            'COLLAB_ENABLED': 'true',
            'COLLAB_AUTH_MODE': 'jupyterhub',
            'COLLAB_WEBSOCKET_URL': f'ws://{self.hub.public_host}:{self.hub.port}/collab',
            'COLLAB_MAX_USERS_PER_NOTEBOOK': '50',
            'COLLAB_LOCK_TIMEOUT': '300',  # 5 minutes
            'COLLAB_HISTORY_RETENTION': '2592000',  # 30 days
        })
        
        # Add collaboration role from user token
        if hasattr(self.user, 'collab_role'):
            env['COLLAB_USER_ROLE'] = self.user.collab_role
            
        return env
    
    def get_args(self):
        args = super().get_args()
        
        # Mount collaboration service configuration
        args.extend([
            '--ServerApp.jpserver_extensions={"jupyter_collaboration": True}',
            '--LabServerApp.collaborative=True',
            '--NotebookApp.collaborative=True'
        ])
        
        return args

c.JupyterHub.spawner_class = CollaborativeDockerSpawner

# Configure resource limits accounting for collaboration overhead
c.DockerSpawner.mem_limit = '2G'  # Base + 50MB per collaborative session
c.DockerSpawner.cpu_limit = 2.0   # Account for 2-3x CPU overhead during collaboration

# Mount collaboration configuration directory
c.DockerSpawner.volumes = {
    '/opt/conda/etc/jupyter': '/opt/conda/etc/jupyter',
    '/srv/jupyterhub/collab-config': '/etc/jupyter/collaboration'
}
```

#### Kubernetes Spawner Configuration

For Kubernetes deployments, configure pods with collaboration support:

**jupyterhub_config.py:**

```python
from kubespawner import KubeSpawner
import os

class CollaborativeKubeSpawner(KubeSpawner):
    """Kubernetes spawner with collaboration support."""
    
    def get_env(self):
        env = super().get_env()
        
        env.update({
            'COLLAB_ENABLED': 'true',
            'COLLAB_AUTH_MODE': 'jupyterhub',
            'COLLAB_WEBSOCKET_URL': f'wss://{os.environ.get("HUB_HOST", "hub.example.com")}/collab',
            'COLLAB_REDIS_URL': 'redis://redis-service:6379',  # For session affinity
        })
        
        return env
    
    def _expand_user_properties(self, template):
        # Get user's collaboration role and add to template context
        template = super()._expand_user_properties(template)
        template['collab_role'] = getattr(self.user, 'collab_role', 'view')
        return template

c.JupyterHub.spawner_class = CollaborativeKubeSpawner

# Configure pod specifications with collaboration requirements
c.KubeSpawner.pod_name_template = 'jupyter-{username}-{collab_role}'

# Configure resource requests and limits
c.KubeSpawner.mem_guarantee = '1G'
c.KubeSpawner.mem_limit = '4G'       # Account for collaboration overhead
c.KubeSpawner.cpu_guarantee = '0.5'
c.KubeSpawner.cpu_limit = '2'        # Account for CRDT processing overhead

# Add labels for session affinity
c.KubeSpawner.common_labels = {
    'collaboration-enabled': 'true',
    'app': 'jupyter-notebook-collab'
}

# Add annotations for service mesh/ingress
c.KubeSpawner.pod_annotations = {
    'collaboration.jupyter.org/websocket-support': 'true',
    'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600',
    'nginx.ingress.kubernetes.io/proxy-send-timeout': '3600'
}
```

### Step 4: Configure Load Balancer and Reverse Proxy

#### Nginx Configuration for WebSocket Support

Configure Nginx to properly handle WebSocket connections with session affinity:

**nginx.conf:**

```nginx
upstream jupyterhub {
    # Enable session affinity for collaboration WebSocket connections
    ip_hash;
    
    server hub1.example.com:8000 max_fails=3 fail_timeout=30s;
    server hub2.example.com:8000 max_fails=3 fail_timeout=30s;
    server hub3.example.com:8000 max_fails=3 fail_timeout=30s;
}

upstream collaboration_websocket {
    # Dedicated upstream for collaboration WebSocket traffic
    ip_hash;  # Required for session affinity
    
    server collab1.example.com:8765 max_fails=1 fail_timeout=10s;
    server collab2.example.com:8765 max_fails=1 fail_timeout=10s;
}

server {
    listen 443 ssl http2;
    server_name notebooks.example.com;
    
    # SSL configuration
    ssl_certificate /path/to/certificate.pem;
    ssl_certificate_key /path/to/private_key.pem;
    
    # WebSocket upgrade headers
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Increase timeouts for long-lived WebSocket connections
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;
    
    # Main JupyterHub traffic
    location / {
        proxy_pass http://jupyterhub;
        
        # Enable sticky sessions
        proxy_cookie_path / "/; Secure; HttpOnly; SameSite=Lax";
    }
    
    # Collaboration WebSocket endpoint
    location /collab/ {
        proxy_pass http://collaboration_websocket;
        
        # Essential WebSocket headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Disable buffering for real-time updates
        proxy_buffering off;
        proxy_cache off;
    }
    
    # Static assets with caching
    location /static/ {
        proxy_pass http://jupyterhub;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

#### HAProxy Configuration Alternative

For HAProxy users, configure session affinity and WebSocket support:

**haproxy.cfg:**

```
global
    log stdout local0
    chroot /var/lib/haproxy
    stats socket /run/haproxy/admin.sock mode 660 level admin
    stats timeout 30s
    user haproxy
    group haproxy
    daemon

defaults
    mode http
    log global
    option httplog
    option dontlognull
    option redispatch
    retries 3
    timeout connect 10s
    timeout client 3600s    # Extended for WebSocket connections
    timeout server 3600s    # Extended for WebSocket connections

frontend jupyterhub_frontend
    bind *:443 ssl crt /path/to/certificate.pem
    redirect scheme https if !{ ssl_fc }
    
    # Route collaboration WebSocket traffic to dedicated backend
    acl is_websocket hdr(Upgrade) -i websocket
    acl is_collab_path path_beg /collab/
    
    use_backend collab_websocket if is_websocket is_collab_path
    default_backend jupyterhub_backend

backend jupyterhub_backend
    balance roundrobin
    cookie SERVERID insert indirect nocache
    
    # Health checks
    option httpchk GET /hub/health
    
    server hub1 hub1.example.com:8000 check cookie hub1
    server hub2 hub2.example.com:8000 check cookie hub2
    server hub3 hub3.example.com:8000 check cookie hub3

backend collab_websocket
    balance source  # Session affinity for WebSocket connections
    
    # WebSocket specific options
    option httpchk GET /health
    timeout tunnel 3600s
    
    server collab1 collab1.example.com:8765 check
    server collab2 collab2.example.com:8765 check
```

### Step 5: Database and Storage Configuration

#### Redis Configuration for Session Affinity

Configure Redis for session state management in multi-replica deployments:

**redis.conf:**

```
# Enable persistence for session state
save 900 1
save 300 10
save 60 10000

# Configure memory management
maxmemory 2gb
maxmemory-policy allkeys-lru

# Enable SSL for production
port 0
tls-port 6379
tls-cert-file /path/to/redis.crt
tls-key-file /path/to/redis.key
tls-ca-cert-file /path/to/ca.crt

# Authentication
requirepass your_secure_redis_password

# Configure for high availability
replica-read-only yes
replica-serve-stale-data yes
```

#### Database Schema for Collaboration Metadata

Create database tables for collaboration history and metadata:

**collaboration_schema.sql:**

```sql
-- Table for storing collaboration session information
CREATE TABLE collaboration_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notebook_path VARCHAR(512) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    active_users JSONB DEFAULT '[]',
    session_config JSONB DEFAULT '{}',
    INDEX idx_notebook_path (notebook_path),
    INDEX idx_updated_at (updated_at)
);

-- Table for storing user permissions per notebook
CREATE TABLE collaboration_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notebook_path VARCHAR(512) NOT NULL,
    username VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('view', 'edit', 'admin')),
    granted_by VARCHAR(255) NOT NULL,
    granted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    UNIQUE KEY unique_user_notebook (notebook_path, username),
    INDEX idx_username (username),
    INDEX idx_notebook_path (notebook_path)
);

-- Table for storing change history
CREATE TABLE collaboration_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notebook_path VARCHAR(512) NOT NULL,
    username VARCHAR(255) NOT NULL,
    change_type VARCHAR(50) NOT NULL,
    change_data JSONB NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    yjs_update BYTEA,
    INDEX idx_notebook_path_time (notebook_path, timestamp),
    INDEX idx_username_time (username, timestamp)
);

-- Table for storing comments and reviews
CREATE TABLE collaboration_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notebook_path VARCHAR(512) NOT NULL,
    cell_id VARCHAR(255) NOT NULL,
    username VARCHAR(255) NOT NULL,
    comment_text TEXT NOT NULL,
    thread_id UUID REFERENCES collaboration_comments(id),
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_notebook_cell (notebook_path, cell_id),
    INDEX idx_thread_id (thread_id)
);
```

## Deployment Topologies

### Small Scale Deployment (1-10 concurrent users)

**Architecture:**
- Single JupyterHub instance with integrated collaboration service
- Local file storage with regular backups
- Basic TLS termination at application layer

**Resource Allocation:**
- **CPU**: 4 cores
- **Memory**: 8GB RAM
- **Storage**: 100GB SSD
- **Network**: 1Gbps connection

**Configuration Example:**

```python
# Simple single-instance configuration
c.JupyterHub.bind_url = 'https://0.0.0.0:443'
c.JupyterHub.ssl_cert = '/path/to/cert.pem'
c.JupyterHub.ssl_key = '/path/to/key.pem'

# Enable collaboration with integrated service
c.JupyterHub.services = [
    {
        'name': 'collaboration',
        'command': ['jupyter-collaboration-server', '--port=8765'],
        'environment': {
            'COLLAB_MAX_USERS': '10',
            'COLLAB_STORAGE_TYPE': 'filesystem',
            'COLLAB_STORAGE_PATH': '/srv/collaboration'
        }
    }
]
```

### Medium Scale Deployment (10-100 concurrent users)

**Architecture:**
- Multi-server deployment with load balancer
- Shared storage backend (NFS or object storage)
- Dedicated Redis instance for session management
- Separate collaboration service instances

**Resource Allocation:**
- **Load Balancer**: 2 CPU cores, 4GB RAM
- **JupyterHub Instances** (2-3): 8 CPU cores, 16GB RAM each
- **Collaboration Services** (2): 4 CPU cores, 8GB RAM each
- **Redis Instance**: 2 CPU cores, 4GB RAM
- **Shared Storage**: High-performance NFS or object storage

**Configuration Example:**

```python
# Multi-instance configuration with Redis
c.JupyterHub.bind_url = 'http://0.0.0.0:8000'  # Behind load balancer

# Configure Redis for session state
c.JupyterHub.authenticator_class = 'oauthenticator.generic.GenericOAuthenticator'
c.GenericOAuthenticator.oauth_callback_url = 'https://notebooks.example.com/hub/oauth_callback'

# External collaboration service
c.JupyterHub.services = [
    {
        'name': 'collaboration',
        'url': 'http://collab.example.com:8765',
        'api_token': 'your-secret-token',
        'environment': {
            'COLLAB_REDIS_URL': 'redis://redis.example.com:6379',
            'COLLAB_MAX_USERS': '100',
            'COLLAB_STORAGE_TYPE': 'database',
            'COLLAB_DATABASE_URL': 'postgresql://user:pass@db.example.com/collab'
        }
    }
]

# Configure shared storage
c.DockerSpawner.volumes = {
    'nfs-storage:/home/{username}': '/home/jovyan',
    'nfs-shared:/shared': '/shared'
}
```

### Large Scale Deployment (100+ concurrent users)

**Architecture:**
- Kubernetes deployment with horizontal pod autoscaling
- Distributed storage with high availability
- Service mesh for inter-service communication
- Multiple Redis instances with clustering
- Dedicated monitoring and logging infrastructure

**Resource Planning:**
- **Auto-scaling**: Based on CPU (70% threshold) and memory (80% threshold)
- **Pod Resources**: 1-4 CPU cores, 2-8GB RAM per pod
- **Storage**: Distributed object storage (S3, MinIO)
- **Networking**: Service mesh with TLS encryption

**Kubernetes Configuration Example:**

```yaml
# kubernetes/collaboration-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: collaboration-service
  labels:
    app: collaboration-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: collaboration-service
  template:
    metadata:
      labels:
        app: collaboration-service
    spec:
      containers:
      - name: collaboration
        image: jupyter/collaboration:latest
        ports:
        - containerPort: 8765
        env:
        - name: COLLAB_REDIS_CLUSTER
          value: "redis-cluster:6379"
        - name: COLLAB_DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: url
        - name: COLLAB_MAX_USERS
          value: "500"
        resources:
          requests:
            cpu: "1"
            memory: "2Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
        livenessProbe:
          httpGet:
            path: /health
            port: 8765
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8765
          initialDelaySeconds: 5
          periodSeconds: 5

---
apiVersion: v1
kind: Service
metadata:
  name: collaboration-service
spec:
  selector:
    app: collaboration-service
  ports:
  - port: 8765
    targetPort: 8765
  type: ClusterIP

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: collaboration-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: collaboration-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

## Monitoring and Observability

### Key Metrics to Monitor

**Collaboration-Specific Metrics:**

```python
# prometheus_metrics.py - Custom metrics for collaboration monitoring
from prometheus_client import Counter, Histogram, Gauge, start_http_server

# WebSocket connection metrics
websocket_connections = Gauge(
    'jupyter_collab_websocket_connections_total',
    'Number of active collaboration WebSocket connections',
    ['notebook_path', 'user_role']
)

# Edit operation latency
edit_latency = Histogram(
    'jupyter_collab_edit_latency_seconds',
    'Latency of collaborative edit operations',
    ['operation_type'],
    buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0]
)

# CRDT operation frequency
crdt_operations = Counter(
    'jupyter_collab_crdt_operations_total',
    'Number of CRDT operations processed',
    ['operation_type', 'notebook_path']
)

# Lock acquisition metrics
lock_acquisitions = Counter(
    'jupyter_collab_lock_acquisitions_total',
    'Number of cell lock acquisitions',
    ['cell_type', 'success']
)

# Memory usage per collaborative session
session_memory = Gauge(
    'jupyter_collab_session_memory_bytes',
    'Memory usage per collaborative session',
    ['notebook_path', 'user_count']
)
```

### Health Check Endpoints

**health_checks.py:**

```python
from fastapi import FastAPI, Response
import asyncio
import redis
import psycopg2
from datetime import datetime

app = FastAPI()

@app.get("/health")
async def health_check():
    """Basic health check for load balancer."""
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}

@app.get("/ready")
async def readiness_check():
    """Comprehensive readiness check for collaboration service."""
    checks = {
        "redis": await check_redis_connection(),
        "database": await check_database_connection(),
        "websocket": await check_websocket_capacity(),
        "memory": check_memory_usage()
    }
    
    all_healthy = all(checks.values())
    status_code = 200 if all_healthy else 503
    
    return Response(
        content=json.dumps({
            "status": "ready" if all_healthy else "not ready",
            "checks": checks,
            "timestamp": datetime.utcnow().isoformat()
        }),
        status_code=status_code,
        media_type="application/json"
    )

async def check_redis_connection():
    """Check Redis connectivity and latency."""
    try:
        r = redis.Redis(host='redis-cluster', port=6379, decode_responses=True)
        start_time = time.time()
        await r.ping()
        latency = time.time() - start_time
        return latency < 0.1  # Healthy if latency < 100ms
    except Exception:
        return False

async def check_database_connection():
    """Check database connectivity."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cursor = conn.cursor()
        cursor.execute("SELECT 1")
        cursor.close()
        conn.close()
        return True
    except Exception:
        return False

async def check_websocket_capacity():
    """Check if service can accept new WebSocket connections."""
    current_connections = websocket_connections._value.sum()
    max_connections = int(os.environ.get('COLLAB_MAX_CONNECTIONS', '1000'))
    return current_connections < max_connections * 0.9  # Healthy if < 90% capacity

def check_memory_usage():
    """Check memory usage is within acceptable limits."""
    import psutil
    memory_percent = psutil.virtual_memory().percent
    return memory_percent < 80  # Healthy if memory usage < 80%
```

## Security Considerations

### Authentication Security

**Token Validation:**

```python
# security/token_validator.py
import jwt
import time
from typing import Optional, Dict, Any

class CollaborationTokenValidator:
    """Validates JupyterHub tokens for collaboration permissions."""
    
    def __init__(self, secret_key: str, algorithm: str = 'HS256'):
        self.secret_key = secret_key
        self.algorithm = algorithm
    
    def validate_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Validate and decode collaboration token."""
        try:
            payload = jwt.decode(
                token, 
                self.secret_key, 
                algorithms=[self.algorithm],
                options={"verify_exp": True}
            )
            
            # Verify required collaboration claims
            required_claims = ['username', 'collab_role', 'collab_permissions']
            if not all(claim in payload for claim in required_claims):
                raise ValueError("Missing required collaboration claims")
            
            # Verify role is valid
            valid_roles = ['view', 'edit', 'admin']
            if payload['collab_role'] not in valid_roles:
                raise ValueError(f"Invalid collaboration role: {payload['collab_role']}")
            
            return payload
            
        except jwt.ExpiredSignatureError:
            raise ValueError("Token has expired")
        except jwt.InvalidTokenError as e:
            raise ValueError(f"Invalid token: {str(e)}")
    
    def has_permission(self, token_payload: Dict[str, Any], 
                      required_permission: str) -> bool:
        """Check if token has required permission."""
        permissions = token_payload.get('collab_permissions', [])
        return required_permission in permissions
```

### Network Security

**TLS Configuration:**

```nginx
# Enhanced TLS configuration for collaboration
server {
    listen 443 ssl http2;
    
    # Modern TLS configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    
    # HSTS for enhanced security
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload";
    
    # Content Security Policy for collaboration features
    add_header Content-Security-Policy "
        default-src 'self';
        script-src 'self' 'unsafe-inline' 'unsafe-eval';
        style-src 'self' 'unsafe-inline';
        connect-src 'self' wss: ws:;
        img-src 'self' data: blob:;
        font-src 'self' data:;
        frame-ancestors 'none';
    ";
    
    # WebSocket security headers
    location /collab/ {
        # Validate WebSocket origin
        if ($http_origin !~ "^https?://(notebooks\.example\.com|localhost)$") {
            return 403;
        }
        
        proxy_pass http://collaboration_websocket;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
    }
}
```

## Troubleshooting Guide

### Common Issues and Solutions

#### WebSocket Connection Failures

**Symptoms:**
- Collaboration features not working
- "Failed to connect to collaboration service" errors
- Users not seeing real-time updates

**Diagnostics:**

```bash
# Check WebSocket connectivity
curl -i -N -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: test" \
     -H "Sec-WebSocket-Version: 13" \
     https://notebooks.example.com/collab/

# Check service status
kubectl get pods -l app=collaboration-service
kubectl logs -f deployment/collaboration-service

# Test Redis connectivity
redis-cli -h redis-cluster ping
```

**Solutions:**

1. **Verify load balancer WebSocket support:**
   ```nginx
   # Ensure these headers are set
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```

2. **Check session affinity configuration:**
   ```nginx
   # Use consistent session routing
   upstream collaboration_websocket {
       ip_hash;  # or least_conn with sticky sessions
       server collab1.example.com:8765;
       server collab2.example.com:8765;
   }
   ```

3. **Verify TLS termination:**
   ```bash
   # Check certificate validity
   openssl s_client -connect notebooks.example.com:443 -servername notebooks.example.com
   ```

#### Performance Issues

**Symptoms:**
- Slow collaboration sync (>100ms latency)
- High CPU usage during collaborative editing
- Memory leaks in long-running sessions

**Diagnostics:**

```bash
# Monitor collaboration metrics
curl http://collaboration-service:8080/metrics | grep jupyter_collab

# Check resource usage
kubectl top pods -l app=collaboration-service

# Analyze CRDT operation frequency
prometheus_query 'rate(jupyter_collab_crdt_operations_total[5m])'
```

**Solutions:**

1. **Optimize CRDT operations:**
   ```python
   # Configure smaller update batches
   COLLAB_UPDATE_BATCH_SIZE = 50
   COLLAB_UPDATE_DEBOUNCE_MS = 100
   ```

2. **Scale collaboration services:**
   ```yaml
   # Increase HPA thresholds
   metrics:
   - type: Resource
     resource:
       name: cpu
       target:
         type: Utilization
         averageUtilization: 50  # Lower threshold for faster scaling
   ```

3. **Tune memory management:**
   ```python
   # Implement periodic cleanup
   COLLAB_CLEANUP_INTERVAL = 3600  # 1 hour
   COLLAB_MAX_HISTORY_SIZE = 1000  # Limit history retention
   ```

#### Permission Issues

**Symptoms:**
- Users cannot edit notebooks despite proper roles
- Permission changes not taking effect
- Authentication failures in collaboration

**Diagnostics:**

```python
# Debug token validation
import jwt
token = request.headers.get('Authorization', '').replace('Bearer ', '')
try:
    payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
    print(f"User: {payload['username']}")
    print(f"Role: {payload['collab_role']}")
    print(f"Permissions: {payload['collab_permissions']}")
except Exception as e:
    print(f"Token validation error: {e}")
```

**Solutions:**

1. **Verify token claims:**
   ```python
   # Ensure all required claims are present
   required_claims = ['username', 'collab_role', 'collab_permissions']
   missing_claims = [claim for claim in required_claims if claim not in payload]
   if missing_claims:
       raise ValueError(f"Missing claims: {missing_claims}")
   ```

2. **Check role mapping:**
   ```python
   # Verify user role assignment logic
   def determine_collaboration_role(self, username):
       # Add debug logging
       logger.info(f"Determining role for user: {username}")
       
       if username in self.admin_users:
           logger.info(f"User {username} assigned admin role")
           return 'admin'
       # ... rest of logic
   ```

3. **Refresh authentication:**
   ```bash
   # Clear token cache and re-authenticate
   kubectl delete secret jupyterhub-oauth-tokens
   kubectl restart deployment/jupyterhub
   ```

## Performance Optimization

### Resource Allocation Guidelines

**Memory Planning:**

```python
# Calculate memory requirements
def calculate_collaboration_memory(concurrent_users, avg_notebook_size_mb):
    """Calculate memory requirements for collaboration features."""
    
    base_memory_mb = 500  # Base collaboration service memory
    
    # Memory per collaborative session
    session_overhead_mb = 50
    
    # CRDT document memory (proportional to notebook size)
    crdt_overhead_factor = 0.3  # 30% overhead for CRDT structures
    
    # User awareness overhead
    awareness_overhead_mb = 5  # Per user
    
    total_memory_mb = (
        base_memory_mb +
        (concurrent_users * session_overhead_mb) +
        (concurrent_users * avg_notebook_size_mb * crdt_overhead_factor) +
        (concurrent_users * awareness_overhead_mb)
    )
    
    return int(total_memory_mb * 1.2)  # 20% safety margin
```

**CPU Planning:**

```python
# CPU scaling recommendations
def calculate_cpu_requirements(concurrent_users, edit_frequency_per_minute):
    """Calculate CPU requirements for collaboration features."""
    
    base_cpu = 0.5  # Base collaboration service CPU
    
    # CPU overhead for CRDT operations (CPU-intensive)
    crdt_cpu_per_operation = 0.001  # 1ms of CPU per operation
    operations_per_minute = concurrent_users * edit_frequency_per_minute
    crdt_cpu_overhead = (operations_per_minute / 60) * crdt_cpu_per_operation
    
    # WebSocket handling overhead
    websocket_cpu_per_user = 0.05
    
    total_cpu = (
        base_cpu +
        crdt_cpu_overhead +
        (concurrent_users * websocket_cpu_per_user)
    )
    
    return max(total_cpu * 2, 1.0)  # 2x safety margin, minimum 1 CPU
```

### Caching Strategies

**Redis Configuration for Optimal Performance:**

```python
# redis_config.py
REDIS_CONFIG = {
    # Memory optimization
    'maxmemory': '4gb',
    'maxmemory-policy': 'allkeys-lru',
    
    # Persistence tuning for collaboration
    'save': ['900 1', '300 10', '60 10000'],
    'rdbcompression': 'yes',
    'rdbchecksum': 'yes',
    
    # Network optimization
    'tcp-keepalive': '300',
    'timeout': '0',
    
    # Collaboration-specific settings
    'hash-max-ziplist-entries': '512',
    'hash-max-ziplist-value': '64',
    'list-max-ziplist-size': '-2',
    'set-max-intset-entries': '512',
}

# Connection pooling for collaboration service
import redis.asyncio as redis

async def create_redis_pool():
    """Create optimized Redis connection pool for collaboration."""
    return redis.ConnectionPool(
        host='redis-cluster',
        port=6379,
        db=0,
        max_connections=50,
        retry_on_timeout=True,
        socket_keepalive=True,
        socket_keepalive_options={
            'TCP_KEEPIDLE': 300,
            'TCP_KEEPINTVL': 30,
            'TCP_KEEPCNT': 3,
        }
    )
```

This migration guide provides comprehensive coverage of implementing collaborative editing capabilities in JupyterHub environments. The configurations and examples can be adapted to specific deployment requirements while maintaining security and performance standards.

## Next Steps

After completing this migration:

1. **Testing Phase**: Conduct thorough testing with representative user groups
2. **Performance Monitoring**: Implement monitoring dashboards and alerting
3. **User Training**: Provide documentation and training for collaborative features
4. **Gradual Rollout**: Use feature flags to enable collaboration incrementally
5. **Backup Strategy**: Implement backup procedures for collaboration metadata
6. **Security Review**: Conduct security audit of collaborative features

For additional support and advanced configurations, refer to the [Jupyter Collaboration Documentation](https://jupyter-collaboration.readthedocs.io/) and the [JupyterHub Administration Guide](https://jupyterhub.readthedocs.io/).