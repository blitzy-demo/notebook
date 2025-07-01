# Collaboration API Reference

This document provides comprehensive API documentation for developers extending Jupyter Notebook v7's collaborative editing capabilities. The collaboration system is built on Yjs CRDT framework and integrates seamlessly with existing notebook components while maintaining backward compatibility.

## Overview

The collaboration API enables developers to build custom collaborative features that integrate with Jupyter Notebook's real-time editing system. The core components provide:

- **Real-time document synchronization** via Yjs CRDT operations
- **User presence and awareness** system for visual collaboration indicators  
- **Cell-level locking mechanism** to prevent editing conflicts
- **Comment and review system** for collaborative discussion
- **Permission-based access control** for enterprise deployments

## Core Architecture

The collaboration system follows a layered architecture that wraps existing notebook components:

```
┌─────────────────────────────────────┐
│ Custom Extension Components         │
├─────────────────────────────────────┤
│ Collaboration API Layer             │
├─────────────────────────────────────┤
│ YjsNotebookProvider                 │
├─────────────────────────────────────┤
│ Standard Notebook Components        │
└─────────────────────────────────────┘
```

## Dependencies and Setup

### Required Dependencies

```json
{
  "dependencies": {
    "yjs": "^13.5.40",
    "y-websocket": "^1.4.0", 
    "y-protocols": "^1.0.5",
    "lib0": "^0.2.0",
    "@jupyterlab/notebook": "^4.5.0",
    "@jupyter-notebook/collaboration": "^7.0.0"
  }
}
```

### TypeScript Imports

```typescript
import { INotebookModel } from '@jupyterlab/notebook';
import { YjsNotebookProvider } from '@jupyter-notebook/collaboration';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
```

## YjsNotebookProvider API

The `YjsNotebookProvider` is the core component that bridges notebook models with Yjs documents for real-time synchronization.

### Interface Definition

```typescript
interface IYjsNotebookProvider {
  /**
   * The underlying Yjs document
   */
  readonly ydoc: Y.Doc;
  
  /**
   * Awareness instance for presence information
   */
  readonly awareness: Awareness;
  
  /**
   * WebSocket provider for network communication
   */
  readonly wsProvider: WebsocketProvider;
  
  /**
   * Current connection state
   */
  readonly connectionState: ConnectionState;
  
  /**
   * Initialize collaboration for a notebook model
   */
  initializeCollaboration(model: INotebookModel): Promise<void>;
  
  /**
   * Dispose of collaboration resources
   */
  dispose(): void;
  
  /**
   * Get the collaborative state for a specific cell
   */
  getCellCollabState(cellId: string): ICellCollabState;
  
  /**
   * Signal emitted when collaboration state changes
   */
  readonly collaborationStateChanged: ISignal<this, ICollaborationStateChange>;
}

enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting', 
  Connected = 'connected',
  Synchronizing = 'synchronizing',
  Synced = 'synced'
}
```

### Basic Usage

```typescript
import { YjsNotebookProvider } from '@jupyter-notebook/collaboration';

// Initialize collaboration provider
const provider = new YjsNotebookProvider({
  websocketUrl: 'ws://localhost:8888/api/collaboration',
  roomName: `notebook:${notebookPath}`,
  token: authToken
});

// Connect to existing notebook model
await provider.initializeCollaboration(notebookModel);

// Listen for collaboration state changes
provider.collaborationStateChanged.connect((sender, change) => {
  console.log('Collaboration state changed:', change);
});
```

### Advanced Configuration

```typescript
interface IYjsProviderOptions {
  /**
   * WebSocket URL for collaboration server
   */
  websocketUrl: string;
  
  /**
   * Unique room identifier for the notebook
   */
  roomName: string;
  
  /**
   * Authentication token
   */
  token: string;
  
  /**
   * Custom awareness configuration
   */
  awarenessConfig?: {
    user: {
      name: string;
      color: string;
      avatar?: string;
    };
  };
  
  /**
   * Connection retry options
   */
  retryConfig?: {
    maxRetries: number;
    retryDelay: number;
    exponentialBackoff: boolean;
  };
  
  /**
   * Performance optimization settings
   */
  performance?: {
    updateThrottleMs: number;
    batchUpdates: boolean;
    compressionLevel: number;
  };
}
```

### Event Handling

```typescript
// Monitor connection state
provider.connectionState.changed.connect((sender, state) => {
  switch (state) {
    case ConnectionState.Connected:
      showCollaborationIndicator(true);
      break;
    case ConnectionState.Disconnected:
      showCollaborationIndicator(false);
      enableSingleUserFallback();
      break;
  }
});

// Handle synchronization events  
provider.ydoc.on('afterTransaction', (tr, doc) => {
  if (tr.origin !== provider) {
    // Remote changes received
    updateUIForRemoteChanges(tr);
  }
});
```

### Cell-Level Operations

```typescript
// Access cell-specific collaborative state
const cellState = provider.getCellCollabState('cell-123');

// Check if cell is locked
if (cellState.isLocked && cellState.lockedBy !== currentUser.id) {
  showCellLockIndicator(cellState.lockedBy);
  disableCellEditing();
}

// Acquire cell lock
const lockAcquired = await provider.acquireCellLock('cell-123');
if (lockAcquired) {
  enableCellEditing();
} else {
  showLockConflictMessage();
}

// Release cell lock
provider.releaseCellLock('cell-123');
```

## CollaborationToolbar API

The `CollaborationToolbar` component provides UI controls for collaborative features and displays active user information.

### Interface Definition

```typescript
interface ICollaborationToolbar extends Widget {
  /**
   * Reference to the collaboration provider
   */
  readonly provider: IYjsNotebookProvider;
  
  /**
   * Current list of active users
   */
  readonly activeUsers: ReadonlyArray<ICollaborativeUser>;
  
  /**
   * Current user's permission level
   */
  readonly userPermission: PermissionLevel;
  
  /**
   * Add custom toolbar item
   */
  addToolbarItem(item: IToolbarItem): void;
  
  /**
   * Remove toolbar item
   */
  removeToolbarItem(itemId: string): void;
  
  /**
   * Update user presence information
   */
  updateUserPresence(users: ICollaborativeUser[]): void;
  
  /**
   * Signal emitted when collaboration action is triggered
   */
  readonly actionTriggered: ISignal<this, ICollaborationAction>;
}

interface ICollaborativeUser {
  id: string;
  name: string;
  color: string;
  avatar?: string;
  isTyping: boolean;
  lastSeen: Date;
  activeCell?: string;
  permission: PermissionLevel;
}

enum PermissionLevel {
  View = 'view',
  Edit = 'edit', 
  Admin = 'admin'
}
```

### Basic Integration

```typescript
import { CollaborationToolbar } from '@jupyter-notebook/collaboration';

// Create toolbar instance
const collabToolbar = new CollaborationToolbar({
  provider: yjsProvider,
  showUserAvatars: true,
  maxVisibleUsers: 5
});

// Add to notebook panel
notebookPanel.toolbar.addItem('collaboration', collabToolbar);

// Listen for collaboration actions
collabToolbar.actionTriggered.connect((sender, action) => {
  switch (action.type) {
    case 'showPermissions':
      openPermissionDialog();
      break;
    case 'shareNotebook':
      openShareDialog();
      break;
  }
});
```

### Custom Toolbar Items

```typescript
interface IToolbarItem {
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  callback: () => void;
  isVisible?: (permission: PermissionLevel) => boolean;
}

// Add custom collaboration feature
const customItem: IToolbarItem = {
  id: 'export-collab',
  label: 'Export with History',
  icon: 'jp-DownloadIcon',
  tooltip: 'Export notebook with collaboration history',
  callback: () => exportNotebookWithHistory(),
  isVisible: (permission) => permission === PermissionLevel.Admin
};

collabToolbar.addToolbarItem(customItem);
```

### Styling and Themes

```css
/* Customize collaboration toolbar appearance */
.jp-NotebookPanel-toolbar .jp-CollaborationToolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}

.jp-CollaborationToolbar-users {
  display: flex;
  align-items: center;
}

.jp-CollaborationToolbar-userAvatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  margin-left: -6px;
  border: 2px solid var(--jp-layout-color1);
}

.jp-CollaborationToolbar-connectionStatus {
  color: var(--jp-success-color1);
}

.jp-CollaborationToolbar-connectionStatus.disconnected {
  color: var(--jp-error-color1);
}
```

## AwarenessLayer API

The `AwarenessLayer` manages visual indicators of user presence, including cursors, selections, and typing indicators.

### Interface Definition

```typescript
interface IAwarenessLayer extends Widget {
  /**
   * Awareness instance from Yjs provider
   */
  readonly awareness: Awareness;
  
  /**
   * Currently tracked remote cursors
   */
  readonly remoteCursors: Map<number, IRemoteCursor>;
  
  /**
   * Register cursor for tracking
   */
  registerCursor(clientId: number, cursor: IRemoteCursor): void;
  
  /**
   * Update cursor position
   */
  updateCursorPosition(clientId: number, position: ICursorPosition): void;
  
  /**
   * Remove cursor
   */
  removeCursor(clientId: number): void;
  
  /**
   * Update selection highlight
   */
  updateSelection(clientId: number, selection: ITextSelection): void;
  
  /**
   * Show typing indicator
   */
  showTypingIndicator(clientId: number, cellId: string): void;
  
  /**
   * Hide typing indicator
   */
  hideTypingIndicator(clientId: number): void;
}

interface IRemoteCursor {
  userId: string;
  userName: string;
  userColor: string;
  position: ICursorPosition;
  isVisible: boolean;
}

interface ICursorPosition {
  cellId: string;
  line: number;
  column: number;
}

interface ITextSelection {
  cellId: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
```

### Implementing Custom Presence Indicators

```typescript
import { AwarenessLayer } from '@jupyter-notebook/collaboration';

class CustomAwarenessLayer extends AwarenessLayer {
  
  constructor(options: IAwarenessLayerOptions) {
    super(options);
    this.setupCustomIndicators();
  }
  
  private setupCustomIndicators(): void {
    // Monitor awareness changes
    this.awareness.on('change', this.handleAwarenessChange.bind(this));
  }
  
  private handleAwarenessChange(changes: any): void {
    // Process awareness updates
    changes.added.forEach((clientId: number) => {
      const user = this.awareness.getStates().get(clientId);
      if (user) {
        this.addUserPresence(clientId, user);
      }
    });
    
    changes.updated.forEach((clientId: number) => {
      const user = this.awareness.getStates().get(clientId);
      if (user) {
        this.updateUserPresence(clientId, user);
      }
    });
    
    changes.removed.forEach((clientId: number) => {
      this.removeUserPresence(clientId);
    });
  }
  
  private addUserPresence(clientId: number, user: any): void {
    // Create custom presence indicator
    const indicator = this.createPresenceIndicator(user);
    this.attachToCell(indicator, user.activeCell);
  }
  
  private createPresenceIndicator(user: any): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'jp-CollabPresence-indicator';
    indicator.style.borderLeftColor = user.color;
    indicator.textContent = user.name;
    return indicator;
  }
}
```

### Awareness State Management

```typescript
// Update current user's awareness state
const updateAwareness = () => {
  const currentState = {
    user: {
      name: 'Current User',
      color: '#3498db',
      avatar: 'user-avatar.png'
    },
    cursor: {
      cellId: activeCell?.id,
      line: cursorPosition.line,
      column: cursorPosition.column
    },
    selection: activeSelection,
    timestamp: Date.now()
  };
  
  awareness.setLocalStateField('user', currentState);
};

// Listen for remote awareness updates
awareness.on('change', ({ added, updated, removed }) => {
  // Handle new users
  added.forEach(clientId => {
    const state = awareness.getStates().get(clientId);
    renderUserPresence(clientId, state);
  });
  
  // Handle user updates
  updated.forEach(clientId => {
    const state = awareness.getStates().get(clientId);
    updateUserPresence(clientId, state);
  });
  
  // Handle user disconnections
  removed.forEach(clientId => {
    removeUserPresence(clientId);
  });
});
```

### Advanced Cursor Rendering

```typescript
class AdvancedCursorRenderer {
  private cursors = new Map<number, HTMLElement>();
  
  renderCursor(clientId: number, cursor: IRemoteCursor): void {
    const cursorElement = this.createCursorElement(cursor);
    this.positionCursor(cursorElement, cursor.position);
    this.cursors.set(clientId, cursorElement);
    
    // Add to appropriate cell
    const cellElement = this.getCellElement(cursor.position.cellId);
    if (cellElement) {
      cellElement.appendChild(cursorElement);
    }
  }
  
  private createCursorElement(cursor: IRemoteCursor): HTMLElement {
    const element = document.createElement('div');
    element.className = 'jp-CollabCursor';
    element.style.borderLeftColor = cursor.userColor;
    
    // Add user label
    const label = document.createElement('div');
    label.className = 'jp-CollabCursor-label';
    label.textContent = cursor.userName;
    label.style.backgroundColor = cursor.userColor;
    element.appendChild(label);
    
    return element;
  }
  
  private positionCursor(element: HTMLElement, position: ICursorPosition): void {
    const editor = this.getEditorForCell(position.cellId);
    if (editor) {
      const coords = editor.coordsChar({ line: position.line, ch: position.column });
      element.style.left = `${coords.left}px`;
      element.style.top = `${coords.top}px`;
    }
  }
}
```

## Comment System API

The comment system enables threaded discussions attached to notebook cells using Yjs Y.Array for real-time synchronization.

### Core Interfaces

```typescript
interface ICommentSystem {
  /**
   * Y.Array storing comment threads
   */
  readonly commentsArray: Y.Array<ICommentThread>;
  
  /**
   * Add comment to a cell
   */
  addComment(cellId: string, content: string, parentId?: string): Promise<IComment>;
  
  /**
   * Update existing comment
   */
  updateComment(commentId: string, content: string): Promise<void>;
  
  /**
   * Delete comment
   */
  deleteComment(commentId: string): Promise<void>;
  
  /**
   * Resolve comment thread
   */
  resolveThread(threadId: string): Promise<void>;
  
  /**
   * Get comments for a cell
   */
  getCommentsForCell(cellId: string): ICommentThread[];
  
  /**
   * Signal emitted when comments change
   */
  readonly commentsChanged: ISignal<this, ICommentChangeEvent>;
}

interface ICommentThread {
  id: string;
  cellId: string;
  comments: IComment[];
  isResolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface IComment {
  id: string;
  threadId: string;
  parentId?: string;
  content: string;
  author: {
    id: string;
    name: string;
    avatar?: string;
  };
  createdAt: Date;
  updatedAt?: Date;
  isDeleted: boolean;
}
```

### Basic Comment Operations

```typescript
import { CommentSystem } from '@jupyter-notebook/collaboration';

// Initialize comment system
const commentSystem = new CommentSystem({
  yjsProvider: provider,
  currentUser: {
    id: 'user-123',
    name: 'John Doe',
    avatar: 'avatar.png'
  }
});

// Add comment to cell
const comment = await commentSystem.addComment(
  'cell-456', 
  'This calculation looks incorrect'
);

// Reply to comment
const reply = await commentSystem.addComment(
  'cell-456',
  'Good catch! Let me fix that.',
  comment.id
);

// Resolve thread
await commentSystem.resolveThread(comment.threadId);
```

### Y.Array Storage Patterns

```typescript
// Direct Y.Array manipulation for advanced use cases
const commentsArray = yjsProvider.ydoc.getArray('comments');

// Add comment with proper structure
const addCommentToYArray = (comment: IComment) => {
  commentsArray.push([{
    id: comment.id,
    threadId: comment.threadId,
    cellId: comment.cellId,
    content: comment.content,
    author: comment.author,
    createdAt: comment.createdAt.toISOString(),
    metadata: {
      version: 1,
      type: 'comment'
    }
  }]);
};

// Listen for Y.Array changes
commentsArray.observe(event => {
  event.changes.added.forEach(item => {
    const comment = item.content.getContent()[0];
    renderNewComment(comment);
  });
  
  event.changes.deleted.forEach(item => {
    const comment = item.content.getContent()[0];
    removeCommentFromUI(comment.id);
  });
});

// Query comments efficiently
const getCommentsForCell = (cellId: string): IComment[] => {
  return commentsArray
    .toArray()
    .filter(comment => comment.cellId === cellId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
};
```

### React Component Integration

```typescript
import React, { useState, useEffect } from 'react';

interface CommentThreadProps {
  cellId: string;
  commentSystem: ICommentSystem;
}

export const CommentThread: React.FC<CommentThreadProps> = ({ 
  cellId, 
  commentSystem 
}) => {
  const [comments, setComments] = useState<ICommentThread[]>([]);
  const [newComment, setNewComment] = useState('');
  
  useEffect(() => {
    // Load existing comments
    setComments(commentSystem.getCommentsForCell(cellId));
    
    // Listen for changes
    const handler = (sender: any, event: ICommentChangeEvent) => {
      if (event.cellId === cellId) {
        setComments(commentSystem.getCommentsForCell(cellId));
      }
    };
    
    commentSystem.commentsChanged.connect(handler);
    
    return () => {
      commentSystem.commentsChanged.disconnect(handler);
    };
  }, [cellId, commentSystem]);
  
  const handleAddComment = async () => {
    if (newComment.trim()) {
      await commentSystem.addComment(cellId, newComment);
      setNewComment('');
    }
  };
  
  return (
    <div className="jp-CommentThread">
      {comments.map(thread => (
        <CommentThreadView 
          key={thread.id}
          thread={thread}
          commentSystem={commentSystem}
        />
      ))}
      
      <div className="jp-CommentThread-input">
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Add a comment..."
        />
        <button onClick={handleAddComment}>
          Add Comment
        </button>
      </div>
    </div>
  );
};

const CommentThreadView: React.FC<{
  thread: ICommentThread;
  commentSystem: ICommentSystem;
}> = ({ thread, commentSystem }) => {
  const handleResolve = () => {
    commentSystem.resolveThread(thread.id);
  };
  
  return (
    <div className={`jp-CommentThread-thread ${thread.isResolved ? 'resolved' : ''}`}>
      <div className="jp-CommentThread-header">
        <span className="jp-CommentThread-count">
          {thread.comments.length} comments
        </span>
        {!thread.isResolved && (
          <button onClick={handleResolve}>
            Resolve
          </button>
        )}
      </div>
      
      {thread.comments.map(comment => (
        <CommentView 
          key={comment.id}
          comment={comment}
          commentSystem={commentSystem}
        />
      ))}
    </div>
  );
};
```

## Extension Development Guidelines

### Creating Custom Collaboration Extensions

```typescript
import { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICollaborationToken } from '@jupyter-notebook/collaboration';

const customCollabExtension: JupyterFrontEndPlugin<void> = {
  id: 'custom-collaboration-extension',
  autoStart: true,
  requires: [ICollaborationToken],
  activate: (app, collaboration) => {
    console.log('Custom collaboration extension activated');
    
    // Access collaboration provider
    const provider = collaboration.provider;
    
    // Add custom collaboration features
    setupCustomFeatures(provider);
  }
};

const setupCustomFeatures = (provider: IYjsNotebookProvider) => {
  // Add custom awareness fields
  provider.awareness.setLocalStateField('customData', {
    activeFeature: 'myExtension',
    status: 'active'
  });
  
  // Listen for custom events
  provider.collaborationStateChanged.connect((sender, change) => {
    if (change.type === 'connectionStateChanged') {
      handleConnectionChange(change.state);
    }
  });
};

export default customCollabExtension;
```

### TypeScript Interface Extensions

```typescript
// Extend core interfaces for custom functionality
declare module '@jupyter-notebook/collaboration' {
  interface ICollaborationStateChange {
    customData?: any;
  }
  
  interface ICollaborativeUser {
    customFields?: Record<string, any>;
  }
}

// Custom event types
interface ICustomCollaborationEvent {
  type: 'customEvent';
  userId: string;
  data: any;
  timestamp: Date;
}

// Extend provider interface
interface IExtendedYjsProvider extends IYjsNotebookProvider {
  sendCustomEvent(event: ICustomCollaborationEvent): void;
  onCustomEvent(callback: (event: ICustomCollaborationEvent) => void): void;
}
```

### Event Handling Patterns

```typescript
// Standard event handling pattern
class CollaborationExtension {
  private disposables = new DisposableSet();
  
  constructor(private provider: IYjsNotebookProvider) {
    this.setupEventHandlers();
  }
  
  private setupEventHandlers(): void {
    // Connection state monitoring
    this.disposables.add(
      this.provider.connectionState.changed.connect(this.onConnectionChange, this)
    );
    
    // Document change monitoring
    this.disposables.add(
      this.provider.ydoc.on('afterTransaction', this.onDocumentChange.bind(this))
    );
    
    // Awareness change monitoring
    this.disposables.add(
      this.provider.awareness.on('change', this.onAwarenessChange.bind(this))
    );
  }
  
  private onConnectionChange(sender: any, state: ConnectionState): void {
    switch (state) {
      case ConnectionState.Connected:
        this.enableCollaborativeFeatures();
        break;
      case ConnectionState.Disconnected:
        this.disableCollaborativeFeatures();
        break;
    }
  }
  
  private onDocumentChange(transaction: Y.Transaction, doc: Y.Doc): void {
    if (transaction.origin !== this.provider) {
      // Handle remote changes
      this.processRemoteChanges(transaction);
    }
  }
  
  private onAwarenessChange(changes: any): void {
    // Process awareness updates
    this.updateUserPresence(changes);
  }
  
  dispose(): void {
    this.disposables.dispose();
  }
}
```

## Performance Optimization

### Efficient Update Handling

```typescript
// Throttle updates for better performance
class OptimizedCollaborationHandler {
  private updateQueue: Array<() => void> = [];
  private isProcessing = false;
  
  queueUpdate(updateFn: () => void): void {
    this.updateQueue.push(updateFn);
    this.processQueueThrottled();
  }
  
  private processQueueThrottled = throttle(() => {
    this.processQueue();
  }, 16); // 60fps limit
  
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.updateQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    // Batch process updates
    const updates = this.updateQueue.splice(0, 10); // Process up to 10 at a time
    
    for (const update of updates) {
      try {
        update();
      } catch (error) {
        console.error('Update failed:', error);
      }
    }
    
    this.isProcessing = false;
    
    // Process remaining updates
    if (this.updateQueue.length > 0) {
      setTimeout(() => this.processQueue(), 0);
    }
  }
}
```

### Memory Management

```typescript
// Efficient resource cleanup
class CollaborationResourceManager {
  private resources = new Set<IDisposable>();
  
  addResource(resource: IDisposable): void {
    this.resources.add(resource);
  }
  
  removeResource(resource: IDisposable): void {
    this.resources.delete(resource);
    resource.dispose();
  }
  
  dispose(): void {
    for (const resource of this.resources) {
      resource.dispose();
    }
    this.resources.clear();
  }
}

// Use WeakMap for automatic cleanup
const userPresenceCache = new WeakMap<ICollaborativeUser, HTMLElement>();
```

## Testing Collaboration Features

### Unit Testing Example

```typescript
import { jest } from '@jest/globals';
import { YjsNotebookProvider } from '@jupyter-notebook/collaboration';

describe('YjsNotebookProvider', () => {
  let provider: YjsNotebookProvider;
  let mockWebSocket: jest.MockedObject<WebSocket>;
  
  beforeEach(() => {
    mockWebSocket = jest.createMockFromModule('ws');
    provider = new YjsNotebookProvider({
      websocketUrl: 'ws://test',
      roomName: 'test-room',
      token: 'test-token'
    });
  });
  
  test('should initialize collaboration', async () => {
    const mockModel = createMockNotebookModel();
    await provider.initializeCollaboration(mockModel);
    
    expect(provider.connectionState).toBe(ConnectionState.Connected);
    expect(provider.ydoc).toBeDefined();
  });
  
  test('should handle awareness updates', () => {
    const awarenessHandler = jest.fn();
    provider.awareness.on('change', awarenessHandler);
    
    // Simulate awareness update
    provider.awareness.setLocalStateField('user', { name: 'Test User' });
    
    expect(awarenessHandler).toHaveBeenCalled();
  });
});
```

### Integration Testing

```typescript
// Test collaborative editing workflow
describe('Collaborative Editing Integration', () => {
  let provider1: YjsNotebookProvider;
  let provider2: YjsNotebookProvider;
  
  beforeEach(async () => {
    // Setup two providers for testing
    provider1 = new YjsNotebookProvider({ /* config */ });
    provider2 = new YjsNotebookProvider({ /* config */ });
    
    await Promise.all([
      provider1.initializeCollaboration(notebookModel1),
      provider2.initializeCollaboration(notebookModel2)
    ]);
  });
  
  test('should synchronize changes between clients', async () => {
    // Make change in provider1
    const cell = provider1.ydoc.getArray('cells').get(0);
    cell.set('source', 'print("Hello, World!")');
    
    // Wait for synchronization
    await waitForSync(provider2);
    
    // Verify change appears in provider2
    const syncedCell = provider2.ydoc.getArray('cells').get(0);
    expect(syncedCell.get('source')).toBe('print("Hello, World!")');
  });
});
```

## Migration Guide

### Upgrading from Single-User to Collaborative

```typescript
// Before (single-user)
const notebookModel = new NotebookModel();

// After (collaborative)
const yjsProvider = new YjsNotebookProvider({
  websocketUrl: collaborationConfig.websocketUrl,
  roomName: `notebook:${notebookPath}`,
  token: authToken
});

await yjsProvider.initializeCollaboration(notebookModel);
```

### Backward Compatibility

The collaboration system is designed to be fully backward compatible:

- Single-user notebooks continue to work without modification
- Collaboration features are opt-in via feature flags
- Standard notebook file format (.ipynb) is preserved
- Existing extensions continue to function normally

## Troubleshooting

### Common Issues

1. **Connection Failures**
   ```typescript
   // Check WebSocket connection
   if (provider.connectionState === ConnectionState.Disconnected) {
     console.log('Collaboration unavailable, falling back to single-user mode');
     enableSingleUserFallback();
   }
   ```

2. **Synchronization Lag**
   ```typescript
   // Monitor sync performance
   const syncStart = Date.now();
   provider.ydoc.on('afterTransaction', () => {
     const syncTime = Date.now() - syncStart;
     if (syncTime > 100) {
       console.warn('Slow synchronization detected:', syncTime + 'ms');
     }
   });
   ```

3. **Memory Leaks**
   ```typescript
   // Proper cleanup
   class CollaborationComponent {
     dispose(): void {
       this.provider.dispose();
       this.awarenessLayer.dispose();
       this.commentSystem.dispose();
     }
   }
   ```

### Debug Configuration

```typescript
// Enable debug logging
window.DEBUG_COLLABORATION = true;

// Enhanced error reporting
provider.on('error', (error) => {
  console.error('Collaboration error:', error);
  sendTelemetry('collaboration_error', {
    error: error.message,
    stack: error.stack,
    timestamp: Date.now()
  });
});
```

## Best Practices

1. **Always implement graceful degradation** to single-user mode
2. **Use throttling** for high-frequency updates 
3. **Clean up resources** properly to prevent memory leaks
4. **Handle network failures** gracefully with retry logic
5. **Test with multiple concurrent users** to verify performance
6. **Follow accessibility guidelines** for collaboration UI elements
7. **Implement proper error boundaries** around collaboration features

## API Reference Summary

The collaboration API provides four main integration points:

- **YjsNotebookProvider**: Core synchronization and document management
- **CollaborationToolbar**: User interface for collaborative features  
- **AwarenessLayer**: Presence indicators and user awareness
- **CommentSystem**: Threaded discussion and review functionality

Each component is designed to integrate seamlessly with existing notebook extensions while providing comprehensive collaboration capabilities built on proven Yjs CRDT technology.