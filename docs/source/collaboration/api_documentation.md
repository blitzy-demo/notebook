# Collaboration API Documentation

## Overview

Jupyter Notebook v7 introduces comprehensive real-time collaboration features built on the [Yjs CRDT (Conflict-free Replicated Data Type) framework](https://github.com/yjs/yjs). This API documentation provides developers with the necessary interfaces, examples, and patterns to build collaboration-aware extensions and integrate custom functionality with the collaboration system.

## Architecture Overview

The collaboration system is architected around several key components:

- **YjsNotebookProvider**: Core orchestrator bridging Jupyter notebook model with Yjs CRDT
- **Awareness System**: Real-time user presence and cursor tracking
- **Locking Mechanism**: Distributed cell-level locking protocol
- **History System**: Version tracking and diff computation
- **Permission System**: Role-based access control integration
- **Comment System**: Threaded inline commenting functionality

### Extension Points

The collaboration system exposes multiple extension points allowing custom functionality:

1. **Collaboration Event Signals**: Subscribe to real-time editing events
2. **Custom Awareness Providers**: Implement specialized presence indicators
3. **Conflict Resolution Strategies**: Define custom merge strategies
4. **Permission Hooks**: Extend access control logic
5. **Comment Processors**: Add custom comment handling
6. **History Analyzers**: Implement specialized diff algorithms

## Core APIs

### YjsNotebookProvider API

The `YjsNotebookProvider` class is the central component that manages the integration between Jupyter's notebook model and Yjs CRDT system.

#### Interface Definition

```typescript
interface IYjsNotebookProvider {
  /**
   * The underlying Yjs document instance
   */
  readonly ydoc: Y.Doc;

  /**
   * Current collaboration state
   */
  readonly isCollaborating: boolean;

  /**
   * Active user count
   */
  readonly userCount: number;

  /**
   * Enable or disable collaboration mode
   */
  setCollaborationEnabled(enabled: boolean): Promise<void>;

  /**
   * Get current collaboration session info
   */
  getSessionInfo(): ICollaborationSessionInfo;

  /**
   * Subscribe to document changes
   */
  onDocumentChange(callback: (changes: Y.YEvent[]) => void): IDisposable;

  /**
   * Subscribe to connection state changes
   */
  onConnectionStateChange(callback: (state: ConnectionState) => void): IDisposable;

  /**
   * Apply a batch of operations atomically
   */
  transact(fn: () => void): void;

  /**
   * Get awareness instance for presence tracking
   */
  getAwareness(): Awareness;

  /**
   * Dispose the provider and clean up resources
   */
  dispose(): void;
}

interface ICollaborationSessionInfo {
  sessionId: string;
  userRole: 'view' | 'edit' | 'admin';
  connectedUsers: ICollaborationUser[];
  documentId: string;
  lastSyncTime: Date;
}

interface ICollaborationUser {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  color: string;
  cursor: ICursorPosition | null;
  isActive: boolean;
}

interface ICursorPosition {
  cellId: string;
  line: number;
  column: number;
}
```

#### Usage Example

```typescript
import { IYjsNotebookProvider } from '@jupyter-notebook/collaboration';

// Get the provider for the current notebook
const provider = app.serviceManager.collaboration.getProvider(
  notebookWidget.context.path
);

// Enable collaboration
await provider.setCollaborationEnabled(true);

// Subscribe to document changes
const disposable = provider.onDocumentChange((changes) => {
  console.log('Document updated:', changes);

  // Process changes
  changes.forEach(change => {
    if (change.target === provider.ydoc.get('cells')) {
      // Handle cell changes
      updateCellUI(change);
    }
  });
});

// Subscribe to connection state
provider.onConnectionStateChange((state) => {
  updateConnectionUI(state);
});

// Get current session information
const sessionInfo = provider.getSessionInfo();
console.log(`Connected users: ${sessionInfo.connectedUsers.length}`);

// Cleanup when done
disposable.dispose();
```

### Collaboration Event Signals

The collaboration system emits various signals that extensions can subscribe to for real-time event handling.

#### Core Signal Interfaces

```typescript
interface ICollaborationSignals {
  /**
   * Emitted when a user joins or leaves the collaboration session
   */
  userPresenceChanged: Signal<ICollaborationManager, IUserPresenceChange>;

  /**
   * Emitted when a cell is locked or unlocked
   */
  cellLockChanged: Signal<ICollaborationManager, ICellLockChange>;

  /**
   * Emitted when a comment is added, updated, or resolved
   */
  commentChanged: Signal<ICollaborationManager, ICommentChange>;

  /**
   * Emitted when the document history changes
   */
  historyChanged: Signal<ICollaborationManager, IHistoryChange>;

  /**
   * Emitted when user permissions change
   */
  permissionsChanged: Signal<ICollaborationManager, IPermissionChange>;

  /**
   * Emitted on collaboration errors
   */
  collaborationError: Signal<ICollaborationManager, ICollaborationError>;
}

interface IUserPresenceChange {
  type: 'joined' | 'left' | 'updated';
  user: ICollaborationUser;
  timestamp: Date;
}

interface ICellLockChange {
  type: 'locked' | 'unlocked';
  cellId: string;
  userId: string;
  timestamp: Date;
}

interface ICommentChange {
  type: 'added' | 'updated' | 'resolved' | 'deleted';
  comment: IComment;
  timestamp: Date;
}

interface IHistoryChange {
  type: 'snapshot' | 'update';
  version: number;
  changes: IHistoryDiff[];
  timestamp: Date;
}

interface IPermissionChange {
  type: 'granted' | 'revoked' | 'updated';
  userId: string;
  role: 'view' | 'edit' | 'admin';
  timestamp: Date;
}
```

#### Signal Subscription Examples

```typescript
// Subscribe to user presence changes
const collaborationManager = app.serviceManager.collaboration;

collaborationManager.userPresenceChanged.connect((manager, change) => {
  switch (change.type) {
    case 'joined':
      showNotification(`${change.user.displayName} joined the session`);
      updateUserList();
      break;
    case 'left':
      showNotification(`${change.user.displayName} left the session`);
      updateUserList();
      break;
    case 'updated':
      updateUserCursor(change.user);
      break;
  }
});

// Subscribe to cell lock changes
collaborationManager.cellLockChanged.connect((manager, change) => {
  const cell = notebook.widgets.find(cell => cell.id === change.cellId);
  if (cell) {
    if (change.type === 'locked') {
      cell.node.classList.add('jp-collab-locked');
      showLockIndicator(cell, change.userId);
    } else {
      cell.node.classList.remove('jp-collab-locked');
      hideLockIndicator(cell);
    }
  }
});

// Subscribe to comment changes
collaborationManager.commentChanged.connect((manager, change) => {
  switch (change.type) {
    case 'added':
      addCommentMarker(change.comment.cellId, change.comment.id);
      if (change.comment.mentions?.includes(currentUser.id)) {
        showCommentNotification(change.comment);
      }
      break;
    case 'resolved':
      updateCommentStatus(change.comment.id, 'resolved');
      break;
  }
});
```

### Awareness API

The Awareness API provides real-time user presence tracking and cursor synchronization.

#### Core Interfaces

```typescript
interface IAwarenessProvider {
  /**
   * Set local user information
   */
  setLocalUser(user: Partial<ICollaborationUser>): void;

  /**
   * Get all active users
   */
  getUsers(): Map<number, ICollaborationUser>;

  /**
   * Subscribe to awareness changes
   */
  on(event: 'change', callback: (changes: IAwarenessChange) => void): void;

  /**
   * Update cursor position
   */
  setCursor(position: ICursorPosition | null): void;

  /**
   * Update user selection
   */
  setSelection(selection: ISelectionRange | null): void;

  /**
   * Set user status
   */
  setStatus(status: 'active' | 'idle' | 'away'): void;
}

interface IAwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

interface ISelectionRange {
  cellId: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
```

#### Awareness Usage Examples

```typescript
// Get awareness provider
const awareness = provider.getAwareness();

// Set local user information
awareness.setLocalUser({
  username: currentUser.username,
  displayName: currentUser.displayName,
  avatar: currentUser.avatar,
  color: generateUserColor(currentUser.id)
});

// Subscribe to presence changes
awareness.on('change', (changes) => {
  // Update UI for new/updated/removed users
  changes.added.forEach(clientId => {
    const user = awareness.getUsers().get(clientId);
    if (user) {
      addUserPresence(user);
    }
  });

  changes.updated.forEach(clientId => {
    const user = awareness.getUsers().get(clientId);
    if (user && user.cursor) {
      updateUserCursor(user);
    }
  });

  changes.removed.forEach(clientId => {
    removeUserPresence(clientId);
  });
});

// Update cursor position when user moves cursor
notebookWidget.content.activeCellChanged.connect(() => {
  const activeCell = notebookWidget.content.activeCell;
  if (activeCell) {
    const editor = activeCell.editor;
    const cursor = editor.getCursorPosition();

    awareness.setCursor({
      cellId: activeCell.model.id,
      line: cursor.line,
      column: cursor.column
    });
  }
});

// Custom presence indicator component
class UserPresenceIndicator extends Widget {
  constructor(private user: ICollaborationUser) {
    super();
    this.addClass('jp-collab-presence-indicator');
    this.update();
  }

  protected onUpdateRequest(): void {
    this.node.innerHTML = `
      <div class="jp-collab-user-avatar" style="background-color: ${this.user.color}">
        <img src="${this.user.avatar}" alt="${this.user.displayName}" />
        <span class="jp-collab-user-name">${this.user.displayName}</span>
        <div class="jp-collab-user-status ${this.user.isActive ? 'active' : 'idle'}"></div>
      </div>
    `;
  }
}
```

### Cell Locking API

The Cell Locking API provides distributed locking mechanisms to prevent simultaneous editing conflicts.

#### Core Interfaces

```typescript
interface ICellLockManager {
  /**
   * Attempt to acquire a lock on a cell
   */
  acquireLock(cellId: string, timeout?: number): Promise<boolean>;

  /**
   * Release a lock on a cell
   */
  releaseLock(cellId: string): Promise<void>;

  /**
   * Check if a cell is currently locked
   */
  isLocked(cellId: string): boolean;

  /**
   * Get the user who owns the lock
   */
  getLockOwner(cellId: string): string | null;

  /**
   * Subscribe to lock state changes
   */
  onLockStateChange(callback: (event: ILockStateChange) => void): IDisposable;

  /**
   * Force release all locks (admin only)
   */
  forceReleaseAllLocks(): Promise<void>;

  /**
   * Get all current locks
   */
  getAllLocks(): Map<string, ILockInfo>;
}

interface ILockInfo {
  cellId: string;
  ownerId: string;
  ownerName: string;
  acquiredAt: Date;
  expiresAt: Date;
  lockType: 'edit' | 'execute';
}

interface ILockStateChange {
  cellId: string;
  locked: boolean;
  ownerId?: string;
  lockType?: 'edit' | 'execute';
}
```

#### Cell Locking Usage Examples

```typescript
// Get lock manager from collaboration service
const lockManager = collaborationService.getLockManager();

// Acquire lock before editing
async function startCellEdit(cellId: string) {
  const lockAcquired = await lockManager.acquireLock(cellId, 30000); // 30sec timeout

  if (lockAcquired) {
    // Enable editing
    enableCellEditing(cellId);

    // Show lock indicator
    showLockIndicator(cellId, 'edit');
  } else {
    // Show lock conflict message
    const owner = lockManager.getLockOwner(cellId);
    showMessage(`Cell is currently being edited by ${owner}`);
  }
}

// Release lock when editing complete
async function finishCellEdit(cellId: string) {
  await lockManager.releaseLock(cellId);
  hideLockIndicator(cellId);
}

// Subscribe to lock changes
lockManager.onLockStateChange((event) => {
  const cell = getCellById(event.cellId);
  if (cell) {
    if (event.locked) {
      // Show lock UI
      cell.addClass('jp-collab-locked');
      const lockIndicator = new CellLockIndicator({
        ownerId: event.ownerId!,
        lockType: event.lockType!
      });
      cell.toolbar.addItem('lock', lockIndicator);
    } else {
      // Remove lock UI
      cell.removeClass('jp-collab-locked');
      cell.toolbar.removeItem('lock');
    }
  }
});

// Custom lock indicator widget
class CellLockIndicator extends Widget {
  constructor(private options: { ownerId: string; lockType: string }) {
    super();
    this.addClass('jp-collab-lock-indicator');
    this.update();
  }

  protected onUpdateRequest(): void {
    const user = getUserById(this.options.ownerId);
    this.node.innerHTML = `
      <div class="jp-collab-lock-icon ${this.options.lockType}">
        <span class="jp-icon jp-icon-lock"></span>
        <span class="jp-collab-lock-owner">${user?.displayName}</span>
      </div>
    `;
  }
}
```

### History API

The History API provides access to version tracking and change history.

#### Core Interfaces

```typescript
interface IHistoryManager {
  /**
   * Get version history for the document
   */
  getHistory(options?: IHistoryOptions): Promise<IHistoryEntry[]>;

  /**
   * Create a manual snapshot
   */
  createSnapshot(description?: string): Promise<string>;

  /**
   * Restore to a specific version
   */
  restoreVersion(versionId: string): Promise<void>;

  /**
   * Get diff between versions
   */
  getDiff(fromVersion: string, toVersion: string): Promise<IHistoryDiff[]>;

  /**
   * Subscribe to history changes
   */
  onHistoryChange(callback: (event: IHistoryChangeEvent) => void): IDisposable;

  /**
   * Get cell-level history
   */
  getCellHistory(cellId: string, options?: IHistoryOptions): Promise<IHistoryEntry[]>;
}

interface IHistoryOptions {
  maxEntries?: number;
  fromDate?: Date;
  toDate?: Date;
  authorId?: string;
}

interface IHistoryEntry {
  versionId: string;
  timestamp: Date;
  authorId: string;
  authorName: string;
  description: string;
  changeType: 'snapshot' | 'edit' | 'structure';
  affectedCells: string[];
  size: number;
}

interface IHistoryDiff {
  cellId: string;
  type: 'added' | 'deleted' | 'modified' | 'moved';
  oldContent?: string;
  newContent?: string;
  oldIndex?: number;
  newIndex?: number;
}

interface IHistoryChangeEvent {
  type: 'snapshot' | 'restore';
  versionId: string;
  authorId: string;
}
```

#### History Usage Examples

```typescript
// Get history manager
const historyManager = collaborationService.getHistoryManager();

// Display version history
async function showHistoryPanel() {
  const history = await historyManager.getHistory({ maxEntries: 50 });

  const historyWidget = new HistoryPanel();
  history.forEach(entry => {
    historyWidget.addHistoryEntry({
      version: entry.versionId,
      timestamp: entry.timestamp,
      author: entry.authorName,
      description: entry.description,
      changes: entry.affectedCells.length
    });
  });

  app.shell.add(historyWidget, 'right');
}

// Compare versions
async function showVersionDiff(fromVersion: string, toVersion: string) {
  const diff = await historyManager.getDiff(fromVersion, toVersion);

  const diffViewer = new DiffViewer();
  diff.forEach(change => {
    diffViewer.addDiffEntry({
      cellId: change.cellId,
      type: change.type,
      oldContent: change.oldContent || '',
      newContent: change.newContent || ''
    });
  });

  diffViewer.show();
}

// Auto-create snapshots
let snapshotTimer: NodeJS.Timeout;

function startAutoSnapshot(intervalMinutes: number = 5) {
  snapshotTimer = setInterval(async () => {
    const activeNotebook = notebookTracker.currentWidget;
    if (activeNotebook && activeNotebook.model.dirty) {
      await historyManager.createSnapshot('Auto-save snapshot');
      console.log('Auto-snapshot created');
    }
  }, intervalMinutes * 60 * 1000);
}

// Custom history panel component
class HistoryPanel extends Widget {
  private historyList: HTMLElement;

  constructor() {
    super();
    this.addClass('jp-collab-history-panel');
    this.title.label = 'Version History';
    this.title.icon = historyIcon;

    this.historyList = document.createElement('ul');
    this.historyList.className = 'jp-collab-history-list';
    this.node.appendChild(this.historyList);
  }

  addHistoryEntry(entry: {
    version: string;
    timestamp: Date;
    author: string;
    description: string;
    changes: number;
  }) {
    const listItem = document.createElement('li');
    listItem.className = 'jp-collab-history-entry';
    listItem.innerHTML = `
      <div class="jp-collab-history-header">
        <span class="jp-collab-history-author">${entry.author}</span>
        <span class="jp-collab-history-time">${entry.timestamp.toLocaleString()}</span>
      </div>
      <div class="jp-collab-history-description">${entry.description}</div>
      <div class="jp-collab-history-changes">${entry.changes} cells changed</div>
      <div class="jp-collab-history-actions">
        <button class="jp-mod-styled" data-action="restore" data-version="${entry.version}">
          Restore
        </button>
        <button class="jp-mod-styled" data-action="diff" data-version="${entry.version}">
          View Changes
        </button>
      </div>
    `;

    this.historyList.appendChild(listItem);
  }
}
```

### Permission API

The Permission API integrates with JupyterHub authentication to provide role-based access control.

#### Core Interfaces

```typescript
interface IPermissionManager {
  /**
   * Check if current user has specific permission
   */
  hasPermission(permission: Permission): Promise<boolean>;

  /**
   * Get current user's role
   */
  getCurrentUserRole(): Promise<UserRole>;

  /**
   * Get permissions for all users
   */
  getAllPermissions(): Promise<Map<string, UserRole>>;

  /**
   * Grant permission to a user (admin only)
   */
  grantPermission(userId: string, role: UserRole): Promise<void>;

  /**
   * Revoke permission from a user (admin only)
   */
  revokePermission(userId: string): Promise<void>;

  /**
   * Subscribe to permission changes
   */
  onPermissionChange(callback: (event: IPermissionChangeEvent) => void): IDisposable;

  /**
   * Invite user to collaboration (admin only)
   */
  inviteUser(email: string, role: UserRole): Promise<void>;
}

type Permission =
  | 'read'           // View notebook content
  | 'write'          // Edit cells and content
  | 'execute'        // Run code cells
  | 'comment'        // Add/edit comments
  | 'history'        // View version history
  | 'admin'          // Manage permissions
  | 'invite';        // Invite new users

type UserRole = 'view' | 'edit' | 'admin';

interface IPermissionChangeEvent {
  userId: string;
  oldRole?: UserRole;
  newRole: UserRole;
  grantedBy: string;
  timestamp: Date;
}

// Permission matrix
const PERMISSION_MATRIX: Record<UserRole, Permission[]> = {
  view: ['read', 'comment'],
  edit: ['read', 'write', 'execute', 'comment', 'history'],
  admin: ['read', 'write', 'execute', 'comment', 'history', 'admin', 'invite']
};
```

#### Permission Usage Examples

```typescript
// Get permission manager
const permissionManager = collaborationService.getPermissionManager();

// Check permissions before actions
async function attemptCellEdit(cellId: string) {
  const canEdit = await permissionManager.hasPermission('write');

  if (canEdit) {
    // Proceed with edit
    await startCellEdit(cellId);
  } else {
    showMessage('You do not have permission to edit this notebook');
  }
}

// Show/hide UI based on permissions
async function updateUI() {
  const userRole = await permissionManager.getCurrentUserRole();
  const canAdmin = await permissionManager.hasPermission('admin');

  // Show/hide admin features
  const adminToolbar = document.querySelector('.jp-collab-admin-toolbar');
  if (adminToolbar) {
    adminToolbar.style.display = canAdmin ? 'block' : 'none';
  }

  // Update cell editing availability
  notebook.widgets.forEach(cell => {
    if (userRole === 'view') {
      cell.readOnly = true;
      cell.addClass('jp-collab-readonly');
    }
  });
}

// Permission management dialog
class PermissionManagementDialog extends Dialog<void> {
  constructor() {
    super({
      title: 'Manage Permissions',
      body: new PermissionManagementWidget(),
      buttons: [
        Dialog.cancelButton(),
        Dialog.okButton({ label: 'Save Changes' })
      ]
    });
  }
}

class PermissionManagementWidget extends Widget {
  private userList: HTMLElement;
  private inviteInput: HTMLInputElement;

  constructor() {
    super();
    this.addClass('jp-collab-permission-widget');
    this.setupUI();
    this.loadUsers();
  }

  private setupUI() {
    this.node.innerHTML = `
      <div class="jp-collab-permission-section">
        <h3>Current Users</h3>
        <ul class="jp-collab-user-list"></ul>
      </div>
      <div class="jp-collab-permission-section">
        <h3>Invite New User</h3>
        <div class="jp-collab-invite-form">
          <input type="email" placeholder="Enter email address" />
          <select>
            <option value="view">View Only</option>
            <option value="edit">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <button class="jp-mod-styled">Send Invite</button>
        </div>
      </div>
    `;

    this.userList = this.node.querySelector('.jp-collab-user-list') as HTMLElement;
    this.inviteInput = this.node.querySelector('input') as HTMLInputElement;
  }

  private async loadUsers() {
    const permissions = await permissionManager.getAllPermissions();

    permissions.forEach((role, userId) => {
      const user = getUserById(userId);
      if (user) {
        this.addUserEntry(user, role);
      }
    });
  }

  private addUserEntry(user: ICollaborationUser, role: UserRole) {
    const listItem = document.createElement('li');
    listItem.className = 'jp-collab-user-entry';
    listItem.innerHTML = `
      <div class="jp-collab-user-info">
        <img src="${user.avatar}" alt="${user.displayName}" />
        <span>${user.displayName}</span>
      </div>
      <select data-user-id="${user.userId}" data-current-role="${role}">
        <option value="view" ${role === 'view' ? 'selected' : ''}>View Only</option>
        <option value="edit" ${role === 'edit' ? 'selected' : ''}>Editor</option>
        <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
      </select>
      <button class="jp-mod-styled jp-mod-warn" data-action="remove" data-user-id="${user.userId}">
        Remove
      </button>
    `;

    this.userList.appendChild(listItem);
  }
}
```

### Comment API

The Comment API enables programmatic management of threaded inline comments.

#### Core Interfaces

```typescript
interface ICommentManager {
  /**
   * Add a comment to a cell
   */
  addComment(cellId: string, content: string, options?: ICommentOptions): Promise<IComment>;

  /**
   * Reply to an existing comment
   */
  replyToComment(commentId: string, content: string): Promise<IComment>;

  /**
   * Update comment content
   */
  updateComment(commentId: string, content: string): Promise<void>;

  /**
   * Delete a comment
   */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Resolve/unresolve a comment thread
   */
  resolveComment(commentId: string, resolved: boolean): Promise<void>;

  /**
   * Get all comments for a cell
   */
  getCellComments(cellId: string): Promise<IComment[]>;

  /**
   * Get all comments in the notebook
   */
  getAllComments(): Promise<IComment[]>;

  /**
   * Subscribe to comment changes
   */
  onCommentChange(callback: (event: ICommentChangeEvent) => void): IDisposable;

  /**
   * Search comments
   */
  searchComments(query: string): Promise<IComment[]>;
}

interface IComment {
  id: string;
  cellId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: Date;
  lastModified?: Date;
  resolved: boolean;
  parentId?: string; // For nested replies
  mentions: string[]; // User IDs mentioned in comment
  reactions: ICommentReaction[];
}

interface ICommentOptions {
  mentions?: string[];
  position?: ICommentPosition;
  urgent?: boolean;
}

interface ICommentPosition {
  line?: number;
  column?: number;
  selection?: ISelectionRange;
}

interface ICommentReaction {
  emoji: string;
  userId: string;
  timestamp: Date;
}

interface ICommentChangeEvent {
  type: 'added' | 'updated' | 'deleted' | 'resolved' | 'reaction';
  comment: IComment;
  authorId: string;
}
```

#### Comment API Usage Examples

```typescript
// Get comment manager
const commentManager = collaborationService.getCommentManager();

// Add comment to cell
async function addCellComment(cellId: string, content: string) {
  const comment = await commentManager.addComment(cellId, content, {
    mentions: extractMentions(content),
    position: getCurrentCursorPosition()
  });

  // Show comment marker in UI
  showCommentMarker(cellId, comment.id);

  // Notify mentioned users
  comment.mentions.forEach(userId => {
    notifyUser(userId, `You were mentioned in a comment by ${comment.authorName}`);
  });
}

// Display comment thread
async function showCommentThread(cellId: string) {
  const comments = await commentManager.getCellComments(cellId);
  const threadWidget = new CommentThreadWidget(cellId, comments);

  // Position near the cell
  const cellWidget = getCellById(cellId);
  if (cellWidget) {
    positionWidget(threadWidget, cellWidget);
  }

  threadWidget.show();
}

// Subscribe to comment notifications
commentManager.onCommentChange((event) => {
  switch (event.type) {
    case 'added':
      if (event.comment.mentions.includes(currentUser.id)) {
        showCommentNotification(event.comment);
      }
      updateCommentCounter(event.comment.cellId);
      break;

    case 'resolved':
      hideCommentMarker(event.comment.id);
      break;

    case 'reaction':
      updateCommentReactions(event.comment.id, event.comment.reactions);
      break;
  }
});

// Custom comment widget
class CommentWidget extends Widget {
  constructor(private comment: IComment) {
    super();
    this.addClass('jp-collab-comment');
    this.update();
  }

  protected onUpdateRequest(): void {
    const resolvedClass = this.comment.resolved ? 'resolved' : '';

    this.node.innerHTML = `
      <div class="jp-collab-comment-header">
        <div class="jp-collab-comment-author">
          <img src="${getUserAvatar(this.comment.authorId)}" />
          <span>${this.comment.authorName}</span>
        </div>
        <div class="jp-collab-comment-timestamp">
          ${formatTimestamp(this.comment.timestamp)}
        </div>
      </div>
      <div class="jp-collab-comment-content ${resolvedClass}">
        ${renderCommentContent(this.comment.content)}
      </div>
      <div class="jp-collab-comment-reactions">
        ${this.renderReactions()}
      </div>
      <div class="jp-collab-comment-actions">
        <button class="jp-mod-subtle" data-action="reply">Reply</button>
        <button class="jp-mod-subtle" data-action="react">React</button>
        <button class="jp-mod-subtle" data-action="resolve">
          ${this.comment.resolved ? 'Unresolve' : 'Resolve'}
        </button>
      </div>
    `;
  }

  private renderReactions(): string {
    const reactionGroups = new Map<string, ICommentReaction[]>();

    this.comment.reactions.forEach(reaction => {
      if (!reactionGroups.has(reaction.emoji)) {
        reactionGroups.set(reaction.emoji, []);
      }
      reactionGroups.get(reaction.emoji)!.push(reaction);
    });

    return Array.from(reactionGroups.entries())
      .map(([emoji, reactions]) => `
        <span class="jp-collab-reaction" data-emoji="${emoji}">
          ${emoji} ${reactions.length}
        </span>
      `).join('');
  }
}

// Comment search functionality
async function searchComments(query: string) {
  const results = await commentManager.searchComments(query);

  const searchResultsWidget = new SearchResultsWidget();
  results.forEach(comment => {
    searchResultsWidget.addResult({
      comment,
      cellId: comment.cellId,
      snippet: extractSearchSnippet(comment.content, query)
    });
  });

  searchResultsWidget.show();
}
```

## TypeScript Interface Definitions

### Core Collaboration Types

```typescript
/**
 * Main collaboration service interface
 */
interface ICollaborationService extends IDisposable {
  /**
   * Whether collaboration is currently enabled
   */
  readonly isEnabled: boolean;

  /**
   * Current collaboration state
   */
  readonly state: CollaborationState;

  /**
   * Get or create provider for a notebook
   */
  getProvider(notebookPath: string): Promise<IYjsNotebookProvider>;

  /**
   * Get collaboration manager
   */
  getManager(): ICollaborationManager;

  /**
   * Enable/disable collaboration globally
   */
  setEnabled(enabled: boolean): Promise<void>;
}

/**
 * Collaboration state enumeration
 */
enum CollaborationState {
  Disabled = 'disabled',
  Connecting = 'connecting',
  Connected = 'connected',
  Synchronizing = 'synchronizing',
  Error = 'error',
  Disconnected = 'disconnected'
}

/**
 * Main collaboration manager interface
 */
interface ICollaborationManager extends IDisposable {
  /**
   * Collaboration signals
   */
  readonly signals: ICollaborationSignals;

  /**
   * Get awareness provider
   */
  getAwareness(): IAwarenessProvider;

  /**
   * Get cell lock manager
   */
  getLockManager(): ICellLockManager;

  /**
   * Get history manager
   */
  getHistoryManager(): IHistoryManager;

  /**
   * Get permission manager
   */
  getPermissionManager(): IPermissionManager;

  /**
   * Get comment manager
   */
  getCommentManager(): ICommentManager;

  /**
   * Current session information
   */
  getSession(): ICollaborationSession | null;
}

/**
 * Collaboration session interface
 */
interface ICollaborationSession {
  sessionId: string;
  notebookPath: string;
  createdAt: Date;
  lastActivity: Date;
  participants: ICollaborationUser[];
  ownerId: string;
  permissions: Map<string, UserRole>;
}

/**
 * WebSocket connection interface
 */
interface ICollaborationConnection extends IDisposable {
  readonly state: 'connecting' | 'connected' | 'disconnected' | 'error';
  readonly url: string;
  readonly lastConnected: Date | null;

  connect(): Promise<void>;
  disconnect(): void;
  send(message: Uint8Array): void;

  onMessage(callback: (message: Uint8Array) => void): IDisposable;
  onStateChange(callback: (state: string) => void): IDisposable;
}
```

### Widget and Component Interfaces

```typescript
/**
 * Collaboration-aware notebook widget
 */
interface ICollaborationNotebook extends INotebookTracker.IWidget {
  /**
   * Collaboration provider for this notebook
   */
  readonly collaborationProvider: IYjsNotebookProvider | null;

  /**
   * Whether this notebook is in collaborative mode
   */
  readonly isCollaborating: boolean;

  /**
   * Enable collaboration for this notebook
   */
  enableCollaboration(): Promise<void>;

  /**
   * Disable collaboration for this notebook
   */
  disableCollaboration(): Promise<void>;
}

/**
 * Collaboration toolbar widget
 */
interface ICollaborationToolbar extends Widget {
  /**
   * Add/remove collaboration controls
   */
  addCollaborationControls(): void;
  removeCollaborationControls(): void;

  /**
   * Update connection status indicator
   */
  updateConnectionStatus(state: CollaborationState): void;

  /**
   * Show/hide user presence bar
   */
  setPresenceVisible(visible: boolean): void;
}

/**
 * User presence widget interface
 */
interface IUserPresenceWidget extends Widget {
  /**
   * Maximum number of visible user avatars
   */
  maxVisibleUsers: number;

  /**
   * Add user to presence display
   */
  addUser(user: ICollaborationUser): void;

  /**
   * Remove user from presence display
   */
  removeUser(userId: string): void;

  /**
   * Update user information
   */
  updateUser(user: ICollaborationUser): void;

  /**
   * Show overflow menu for additional users
   */
  showUserOverflow(): void;
}
```

### Extension and Plugin Interfaces

```typescript
/**
 * Collaboration extension plugin interface
 */
interface ICollaborationExtension {
  /**
   * Plugin identifier
   */
  readonly id: string;

  /**
   * Plugin display name
   */
  readonly name: string;

  /**
   * Plugin version
   */
  readonly version: string;

  /**
   * Initialize the extension
   */
  initialize(app: JupyterFrontEnd, manager: ICollaborationManager): Promise<void>;

  /**
   * Cleanup extension resources
   */
  dispose(): void;
}

/**
 * Custom collaboration widget factory
 */
interface ICollaborationWidgetFactory<T extends Widget = Widget> {
  /**
   * Create widget for collaboration feature
   */
  createWidget(options: ICollaborationWidgetOptions): T;

  /**
   * Widget type identifier
   */
  readonly widgetType: string;
}

interface ICollaborationWidgetOptions {
  collaborationManager: ICollaborationManager;
  notebookWidget?: INotebookTracker.IWidget;
  settings?: ISettingRegistry.ISettings;
}
```

## Extension Development Examples

### Building Custom Presence Indicators

```typescript
/**
 * Custom extension for enhanced user presence display
 */
class EnhancedPresenceExtension implements ICollaborationExtension {
  readonly id = 'enhanced-presence-extension';
  readonly name = 'Enhanced Presence Indicators';
  readonly version = '1.0.0';

  private app: JupyterFrontEnd;
  private manager: ICollaborationManager;
  private widgets = new Set<EnhancedPresenceWidget>();

  async initialize(app: JupyterFrontEnd, manager: ICollaborationManager): Promise<void> {
    this.app = app;
    this.manager = manager;

    // Register custom presence widget factory
    app.registerWidgetFactory(new EnhancedPresenceWidgetFactory(manager));

    // Add presence widget to all notebook panels
    manager.signals.userPresenceChanged.connect(this.onPresenceChanged, this);

    // Add command for toggling enhanced presence
    app.commands.addCommand('enhanced-presence:toggle', {
      label: 'Toggle Enhanced Presence',
      execute: () => this.toggleEnhancedPresence()
    });
  }

  private onPresenceChanged(manager: ICollaborationManager, change: IUserPresenceChange): void {
    // Update all presence widgets
    this.widgets.forEach(widget => {
      widget.handlePresenceChange(change);
    });
  }

  private toggleEnhancedPresence(): void {
    const isVisible = this.widgets.size > 0;
    if (isVisible) {
      this.hideEnhancedPresence();
    } else {
      this.showEnhancedPresence();
    }
  }

  dispose(): void {
    this.widgets.forEach(widget => widget.dispose());
    this.widgets.clear();
  }
}

/**
 * Enhanced presence widget with detailed user information
 */
class EnhancedPresenceWidget extends Widget {
  private userMap = new Map<string, ICollaborationUser>();
  private container: HTMLElement;

  constructor(private manager: ICollaborationManager) {
    super();
    this.addClass('jp-enhanced-presence-widget');
    this.setupUI();
    this.connectSignals();
  }

  private setupUI(): void {
    this.container = document.createElement('div');
    this.container.className = 'jp-enhanced-presence-container';
    this.node.appendChild(this.container);
  }

  private connectSignals(): void {
    // Subscribe to awareness changes
    const awareness = this.manager.getAwareness();
    awareness.on('change', (changes) => {
      this.updatePresenceDisplay(changes);
    });
  }

  handlePresenceChange(change: IUserPresenceChange): void {
    switch (change.type) {
      case 'joined':
        this.userMap.set(change.user.userId, change.user);
        this.addUserPresence(change.user);
        break;
      case 'left':
        this.userMap.delete(change.user.userId);
        this.removeUserPresence(change.user.userId);
        break;
      case 'updated':
        this.userMap.set(change.user.userId, change.user);
        this.updateUserPresence(change.user);
        break;
    }
  }

  private addUserPresence(user: ICollaborationUser): void {
    const userElement = document.createElement('div');
    userElement.className = 'jp-enhanced-presence-user';
    userElement.dataset.userId = user.userId;

    userElement.innerHTML = `
      <div class="jp-presence-avatar" style="border-color: ${user.color}">
        <img src="${user.avatar}" alt="${user.displayName}" />
        <div class="jp-presence-status ${user.isActive ? 'active' : 'idle'}"></div>
      </div>
      <div class="jp-presence-info">
        <div class="jp-presence-name">${user.displayName}</div>
        <div class="jp-presence-activity">
          ${this.formatUserActivity(user)}
        </div>
      </div>
      <div class="jp-presence-cursor" style="background-color: ${user.color}">
        ${user.cursor ? this.formatCursorPosition(user.cursor) : 'Not editing'}
      </div>
    `;

    this.container.appendChild(userElement);
  }

  private formatUserActivity(user: ICollaborationUser): string {
    if (!user.isActive) return 'Idle';
    if (user.cursor) return `Editing Cell ${user.cursor.cellId.slice(0, 8)}...`;
    return 'Viewing notebook';
  }

  private formatCursorPosition(cursor: ICursorPosition): string {
    return `Line ${cursor.line + 1}, Col ${cursor.column + 1}`;
  }
}
```

### Creating Collaboration-Aware Tools

```typescript
/**
 * Collaborative code analysis tool
 */
class CollaborativeCodeAnalyzer {
  private manager: ICollaborationManager;
  private analysisResults = new Map<string, ICodeAnalysis>();

  constructor(manager: ICollaborationManager) {
    this.manager = manager;
    this.setupCollaborationHooks();
  }

  private setupCollaborationHooks(): void {
    // React to cell content changes
    const provider = this.manager.getProvider();
    provider?.onDocumentChange((changes) => {
      changes.forEach(change => {
        if (this.isCellContentChange(change)) {
          this.scheduleAnalysis(change.target);
        }
      });
    });

    // Share analysis results via comments
    this.manager.signals.userPresenceChanged.connect((manager, change) => {
      if (change.type === 'joined') {
        this.shareAnalysisResults(change.user.userId);
      }
    });
  }

  async analyzeCell(cellId: string): Promise<ICodeAnalysis> {
    const cellContent = this.getCellContent(cellId);
    const analysis = await this.performAnalysis(cellContent);

    // Store analysis results
    this.analysisResults.set(cellId, analysis);

    // Share critical issues via comments
    if (analysis.criticalIssues.length > 0) {
      await this.createAnalysisComment(cellId, analysis);
    }

    return analysis;
  }

  private async createAnalysisComment(cellId: string, analysis: ICodeAnalysis): Promise<void> {
    const commentManager = this.manager.getCommentManager();

    const issues = analysis.criticalIssues
      .map(issue => `- ${issue.type}: ${issue.message}`)
      .join('\n');

    await commentManager.addComment(cellId,
      `🔍 **Code Analysis Results**\n\nCritical Issues Found:\n${issues}`,
      { urgent: true }
    );
  }
}

interface ICodeAnalysis {
  cellId: string;
  timestamp: Date;
  complexity: number;
  criticalIssues: ICodeIssue[];
  suggestions: string[];
  performance: IPerformanceMetrics;
}

interface ICodeIssue {
  type: 'syntax' | 'logic' | 'performance' | 'security';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  line: number;
  column: number;
}
```

### Implementing Custom Conflict Resolution

```typescript
/**
 * Custom conflict resolution strategy for specific cell types
 */
class SmartConflictResolver {
  private manager: ICollaborationManager;

  constructor(manager: ICollaborationManager) {
    this.manager = manager;
    this.setupConflictHandling();
  }

  private setupConflictHandling(): void {
    // Hook into Yjs document changes to detect conflicts
    const provider = this.manager.getProvider();
    if (provider) {
      provider.ydoc.on('update', (update: Uint8Array, origin: any) => {
        if (origin !== this) {
          this.detectAndResolveConflicts(update);
        }
      });
    }
  }

  private async detectAndResolveConflicts(update: Uint8Array): Promise<void> {
    const changes = this.parseYjsUpdate(update);

    for (const change of changes) {
      if (this.isConflictingChange(change)) {
        await this.resolveConflict(change);
      }
    }
  }

  private async resolveConflict(conflict: IConflictChange): Promise<void> {
    const cellType = this.getCellType(conflict.cellId);

    switch (cellType) {
      case 'markdown':
        await this.resolveMarkdownConflict(conflict);
        break;
      case 'code':
        await this.resolveCodeConflict(conflict);
        break;
      case 'raw':
        await this.resolveRawConflict(conflict);
        break;
    }
  }

  private async resolveMarkdownConflict(conflict: IConflictChange): Promise<void> {
    // Use intelligent text merging for markdown
    const mergedContent = await this.intelligentTextMerge(
      conflict.localContent,
      conflict.remoteContent,
      conflict.baseContent
    );

    // Apply merged content
    this.applyCellContent(conflict.cellId, mergedContent);

    // Create comment about the merge
    const commentManager = this.manager.getCommentManager();
    await commentManager.addComment(
      conflict.cellId,
      `📝 **Auto-merged conflicting changes**\n\nConflict detected and automatically resolved using intelligent text merging.`,
      { urgent: false }
    );
  }

  private async resolveCodeConflict(conflict: IConflictChange): Promise<void> {
    // More conservative approach for code - prefer manual resolution
    const lockManager = this.manager.getLockManager();

    // Lock the cell to prevent further edits
    await lockManager.acquireLock(conflict.cellId, 300000); // 5 minutes

    // Create detailed conflict comment
    const commentManager = this.manager.getCommentManager();
    await commentManager.addComment(
      conflict.cellId,
      `⚠️ **Code Conflict Detected**\n\nAutomatic resolution is not safe for code cells. Please review and merge manually:\n\n**Local changes:**\n\`\`\`\n${conflict.localContent}\n\`\`\`\n\n**Remote changes:**\n\`\`\`\n${conflict.remoteContent}\n\`\`\``,
      { urgent: true }
    );

    // Show conflict resolution dialog
    this.showConflictResolutionDialog(conflict);
  }

  private async intelligentTextMerge(local: string, remote: string, base: string): Promise<string> {
    // Implement three-way merge algorithm
    const localDiff = this.computeDiff(base, local);
    const remoteDiff = this.computeDiff(base, remote);

    return this.mergeDiffs(base, localDiff, remoteDiff);
  }
}

interface IConflictChange {
  cellId: string;
  localContent: string;
  remoteContent: string;
  baseContent: string;
  timestamp: Date;
  authors: string[];
}
```

## WebSocket Protocol Details

### Yjs Protocol Implementation

The collaboration system uses the standard Yjs WebSocket protocol with some custom extensions:

```typescript
/**
 * WebSocket message types for collaboration
 */
enum CollaborationMessageType {
  // Standard Yjs protocol
  YJS_UPDATE = 0,
  YJS_AWARENESS = 1,

  // Custom extensions
  NOTEBOOK_METADATA = 100,
  CELL_LOCK = 101,
  COMMENT_UPDATE = 102,
  PERMISSION_CHANGE = 103,
  HISTORY_SNAPSHOT = 104,
  USER_ACTIVITY = 105
}

/**
 * WebSocket message structure
 */
interface ICollaborationMessage {
  type: CollaborationMessageType;
  timestamp: number;
  userId: string;
  sessionId: string;
  data: Uint8Array | object;
}

/**
 * Custom WebSocket provider implementation
 */
class JupyterWebSocketProvider extends WebSocket {
  private ydoc: Y.Doc;
  private awareness: Awareness;
  private messageHandlers = new Map<CollaborationMessageType, Function>();

  constructor(url: string, notebookPath: string, ydoc: Y.Doc) {
    super(`${url}?notebook=${encodeURIComponent(notebookPath)}`);
    this.ydoc = ydoc;
    this.awareness = new Awareness(ydoc);
    this.setupMessageHandlers();
    this.setupEventHandlers();
  }

  private setupMessageHandlers(): void {
    this.messageHandlers.set(
      CollaborationMessageType.YJS_UPDATE,
      this.handleYjsUpdate.bind(this)
    );

    this.messageHandlers.set(
      CollaborationMessageType.YJS_AWARENESS,
      this.handleAwarenessUpdate.bind(this)
    );

    this.messageHandlers.set(
      CollaborationMessageType.CELL_LOCK,
      this.handleCellLockUpdate.bind(this)
    );

    this.messageHandlers.set(
      CollaborationMessageType.COMMENT_UPDATE,
      this.handleCommentUpdate.bind(this)
    );
  }

  private setupEventHandlers(): void {
    // Handle incoming WebSocket messages
    this.onmessage = (event) => {
      const message = this.parseMessage(event.data);
      const handler = this.messageHandlers.get(message.type);

      if (handler) {
        handler(message);
      }
    };

    // Handle Yjs document updates
    this.ydoc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== this && this.readyState === WebSocket.OPEN) {
        this.sendYjsUpdate(update);
      }
    });

    // Handle awareness changes
    this.awareness.on('change', (changes: any) => {
      if (this.readyState === WebSocket.OPEN) {
        this.sendAwarenessUpdate(changes);
      }
    });
  }

  private sendYjsUpdate(update: Uint8Array): void {
    const message: ICollaborationMessage = {
      type: CollaborationMessageType.YJS_UPDATE,
      timestamp: Date.now(),
      userId: this.getCurrentUserId(),
      sessionId: this.getSessionId(),
      data: update
    };

    this.send(this.encodeMessage(message));
  }

  private handleYjsUpdate(message: ICollaborationMessage): void {
    if (message.data instanceof Uint8Array) {
      Y.applyUpdate(this.ydoc, message.data, this);
    }
  }

  sendCustomMessage(type: CollaborationMessageType, data: object): void {
    if (this.readyState === WebSocket.OPEN) {
      const message: ICollaborationMessage = {
        type,
        timestamp: Date.now(),
        userId: this.getCurrentUserId(),
        sessionId: this.getSessionId(),
        data
      };

      this.send(this.encodeMessage(message));
    }
  }
}
```

### Server-Side Protocol Handler

```python
# Server-side WebSocket handler (Python)
import asyncio
import json
from typing import Dict, Set
from tornado.websocket import WebSocketHandler
import y_py as Y

class CollaborationWebSocketHandler(WebSocketHandler):
    # Class-level storage for active sessions
    active_sessions: Dict[str, Set[WebSocketHandler]] = {}
    notebook_documents: Dict[str, Y.YDoc] = {}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.notebook_path: str = ""
        self.user_id: str = ""
        self.session_id: str = ""

    def open(self, *args):
        # Extract notebook path and user info
        self.notebook_path = self.get_argument('notebook', '')
        self.user_id = self.get_current_user()['id']
        self.session_id = self.generate_session_id()

        # Add to active session
        if self.notebook_path not in self.active_sessions:
            self.active_sessions[self.notebook_path] = set()
            self.notebook_documents[self.notebook_path] = Y.YDoc()

        self.active_sessions[self.notebook_path].add(self)

        # Send initial document state
        self.send_initial_state()

    def on_message(self, message):
        try:
            # Parse message
            data = json.loads(message)
            message_type = data.get('type')

            # Route message based on type
            if message_type == 0:  # YJS_UPDATE
                self.handle_yjs_update(data)
            elif message_type == 1:  # YJS_AWARENESS
                self.handle_awareness_update(data)
            elif message_type == 101:  # CELL_LOCK
                self.handle_cell_lock_update(data)
            elif message_type == 102:  # COMMENT_UPDATE
                self.handle_comment_update(data)

        except Exception as e:
            print(f"Error handling message: {e}")

    def handle_yjs_update(self, data):
        # Apply update to document
        ydoc = self.notebook_documents[self.notebook_path]
        update_data = bytes(data['data'])
        Y.apply_update(ydoc, update_data)

        # Broadcast to other clients
        self.broadcast_to_others(data)

        # Persist document state
        asyncio.create_task(self.persist_document_state())

    def broadcast_to_others(self, message):
        # Send message to all other clients in session
        for client in self.active_sessions[self.notebook_path]:
            if client != self and not client.ws_connection.is_closing():
                try:
                    client.write_message(json.dumps(message))
                except Exception as e:
                    print(f"Error broadcasting message: {e}")

    async def persist_document_state(self):
        # Save document state to persistent storage
        ydoc = self.notebook_documents[self.notebook_path]
        encoded_state = Y.encode_state_as_update(ydoc)

        # Save to database/file system
        await self.save_document_state(self.notebook_path, encoded_state)
```

## Performance Best Practices

### Optimizing Real-Time Synchronization

```typescript
/**
 * Performance optimization utilities for collaboration
 */
class CollaborationPerformanceOptimizer {
  private updateQueue: Y.YEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly batchDelay = 50; // ms

  constructor(private provider: IYjsNotebookProvider) {
    this.setupOptimizations();
  }

  private setupOptimizations(): void {
    // Batch document updates
    this.provider.onDocumentChange((changes) => {
      this.queueUpdates(changes);
    });

    // Optimize awareness updates
    this.setupAwarenessThrottling();

    // Memory management
    this.setupMemoryOptimization();
  }

  private queueUpdates(changes: Y.YEvent[]): void {
    this.updateQueue.push(...changes);

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      this.processBatchedUpdates();
    }, this.batchDelay);
  }

  private processBatchedUpdates(): void {
    if (this.updateQueue.length === 0) return;

    // Merge similar updates
    const mergedUpdates = this.mergeUpdates(this.updateQueue);

    // Apply updates efficiently
    this.applyOptimizedUpdates(mergedUpdates);

    // Clear queue
    this.updateQueue = [];
    this.batchTimer = null;
  }

  private mergeUpdates(updates: Y.YEvent[]): Y.YEvent[] {
    const merged = new Map<string, Y.YEvent>();

    updates.forEach(update => {
      const key = this.getUpdateKey(update);
      if (merged.has(key)) {
        // Merge with existing update
        merged.set(key, this.mergeYEvents(merged.get(key)!, update));
      } else {
        merged.set(key, update);
      }
    });

    return Array.from(merged.values());
  }

  private setupAwarenessThrottling(): void {
    const awareness = this.provider.getAwareness();
    let awarenessTimer: NodeJS.Timeout | null = null;

    const originalSetLocalState = awareness.setLocalState;
    awareness.setLocalState = (state: any) => {
      if (awarenessTimer) {
        clearTimeout(awarenessTimer);
      }

      awarenessTimer = setTimeout(() => {
        originalSetLocalState.call(awareness, state);
      }, 100); // Throttle to 10 updates per second
    };
  }

  private setupMemoryOptimization(): void {
    // Periodic cleanup of old states
    setInterval(() => {
      this.cleanupOldStates();
    }, 300000); // Every 5 minutes
  }

  private cleanupOldStates(): void {
    const ydoc = this.provider.ydoc;
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    // Clean up old awareness states
    const awareness = this.provider.getAwareness();
    awareness.getStates().forEach((state, clientId) => {
      if (now - state.lastActivity > maxAge) {
        awareness.removeAwarenessStates([clientId], 'cleanup');
      }
    });
  }
}

/**
 * Virtual scrolling for large user lists
 */
class VirtualUserList extends Widget {
  private itemHeight = 40;
  private visibleItems = 10;
  private scrollContainer: HTMLElement;
  private contentContainer: HTMLElement;
  private users: ICollaborationUser[] = [];

  constructor() {
    super();
    this.setupVirtualScrolling();
  }

  private setupVirtualScrolling(): void {
    this.scrollContainer = document.createElement('div');
    this.scrollContainer.className = 'jp-virtual-user-scroll';
    this.scrollContainer.style.height = `${this.visibleItems * this.itemHeight}px`;
    this.scrollContainer.style.overflowY = 'auto';

    this.contentContainer = document.createElement('div');
    this.contentContainer.className = 'jp-virtual-user-content';

    this.scrollContainer.appendChild(this.contentContainer);
    this.node.appendChild(this.scrollContainer);

    // Handle scroll events
    this.scrollContainer.addEventListener('scroll', () => {
      this.updateVisibleItems();
    });
  }

  setUsers(users: ICollaborationUser[]): void {
    this.users = users;
    this.contentContainer.style.height = `${users.length * this.itemHeight}px`;
    this.updateVisibleItems();
  }

  private updateVisibleItems(): void {
    const scrollTop = this.scrollContainer.scrollTop;
    const startIndex = Math.floor(scrollTop / this.itemHeight);
    const endIndex = Math.min(startIndex + this.visibleItems + 1, this.users.length);

    // Clear existing items
    this.contentContainer.innerHTML = '';

    // Render visible items
    for (let i = startIndex; i < endIndex; i++) {
      const user = this.users[i];
      const userElement = this.createUserElement(user);
      userElement.style.position = 'absolute';
      userElement.style.top = `${i * this.itemHeight}px`;
      userElement.style.height = `${this.itemHeight}px`;
      this.contentContainer.appendChild(userElement);
    }
  }
}
```

### Memory Management Guidelines

```typescript
/**
 * Memory management best practices
 */
class CollaborationMemoryManager {
  private disposables = new Set<IDisposable>();
  private eventListeners = new Set<{ element: EventTarget; event: string; handler: Function }>();

  registerDisposable(disposable: IDisposable): void {
    this.disposables.add(disposable);
  }

  addEventListener(element: EventTarget, event: string, handler: Function): void {
    element.addEventListener(event, handler as EventListener);
    this.eventListeners.add({ element, event, handler });
  }

  dispose(): void {
    // Dispose all registered disposables
    this.disposables.forEach(disposable => {
      try {
        disposable.dispose();
      } catch (error) {
        console.warn('Error disposing resource:', error);
      }
    });
    this.disposables.clear();

    // Remove all event listeners
    this.eventListeners.forEach(({ element, event, handler }) => {
      try {
        element.removeEventListener(event, handler as EventListener);
      } catch (error) {
        console.warn('Error removing event listener:', error);
      }
    });
    this.eventListeners.clear();
  }
}

/**
 * Usage example with proper cleanup
 */
class CollaborationExtension {
  private memoryManager = new CollaborationMemoryManager();

  initialize(): void {
    // Register all disposables
    const signalConnection = collaborationManager.signals.userPresenceChanged.connect(
      this.onPresenceChanged, this
    );
    this.memoryManager.registerDisposable(signalConnection);

    // Register DOM event listeners
    this.memoryManager.addEventListener(
      document, 'keydown', this.handleKeyDown.bind(this)
    );

    // Register timers
    const timer = setInterval(() => this.periodicCleanup(), 60000);
    this.memoryManager.registerDisposable({
      dispose: () => clearInterval(timer)
    });
  }

  dispose(): void {
    this.memoryManager.dispose();
  }
}
```

## Migration Guide for Existing Extensions

### Updating Extensions for Collaboration Support

#### 1. Basic Migration Steps

```typescript
// Before: Simple notebook extension
class SimpleNotebookExtension {
  initialize(app: JupyterFrontEnd, tracker: INotebookTracker): void {
    // Direct notebook manipulation
    tracker.currentChanged.connect((tracker, notebook) => {
      if (notebook) {
        this.setupNotebook(notebook);
      }
    });
  }

  private setupNotebook(notebook: NotebookPanel): void {
    // Direct model access
    notebook.content.model.cells.changed.connect(this.onCellsChanged, this);
  }
}

// After: Collaboration-aware extension
class CollaborationAwareExtension {
  initialize(
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    collaborationService?: ICollaborationService  // Optional dependency
  ): void {
    tracker.currentChanged.connect(async (tracker, notebook) => {
      if (notebook) {
        await this.setupNotebook(notebook);
      }
    });
  }

  private async setupNotebook(notebook: NotebookPanel): Promise<void> {
    // Check if collaboration is enabled
    const isCollaborating = this.isCollaborationEnabled(notebook);

    if (isCollaborating) {
      // Use collaboration-aware approach
      await this.setupCollaborativeNotebook(notebook);
    } else {
      // Fallback to standard approach
      this.setupStandardNotebook(notebook);
    }
  }

  private async setupCollaborativeNotebook(notebook: NotebookPanel): Promise<void> {
    // Get collaboration provider
    const provider = await this.getCollaborationProvider(notebook);

    if (provider) {
      // Subscribe to collaborative changes
      provider.onDocumentChange((changes) => {
        this.handleCollaborativeChanges(changes);
      });

      // Use Yjs document instead of direct model access
      const yjsCells = provider.ydoc.getArray('cells');
      yjsCells.observe(this.onYjsCellsChanged.bind(this));
    }
  }

  private isCollaborationEnabled(notebook: NotebookPanel): boolean {
    // Check if notebook has collaboration provider
    return (notebook as any).collaborationProvider != null;
  }
}
```

#### 2. Handling State Synchronization

```typescript
// Before: Local state management
class StatefulExtension {
  private state = new Map<string, any>();

  updateState(key: string, value: any): void {
    this.state.set(key, value);
    this.saveStateToLocalStorage();
  }
}

// After: Collaborative state management
class CollaborativeStatefulExtension {
  private localState = new Map<string, any>();
  private sharedState: Y.Map<any> | null = null;

  async initialize(notebook: NotebookPanel): Promise<void> {
    const provider = await this.getCollaborationProvider(notebook);

    if (provider) {
      // Use shared Yjs Map for collaborative state
      this.sharedState = provider.ydoc.getMap('extension-state');
      this.sharedState.observe(this.onSharedStateChange.bind(this));
    }
  }

  updateState(key: string, value: any): void {
    if (this.sharedState) {
      // Update shared state (will sync to all clients)
      this.sharedState.set(key, value);
    } else {
      // Fallback to local state
      this.localState.set(key, value);
      this.saveStateToLocalStorage();
    }
  }

  private onSharedStateChange(event: Y.YMapEvent<any>): void {
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'add' || change.action === 'update') {
        this.handleStateChange(key, this.sharedState!.get(key));
      }
    });
  }
}
```

#### 3. UI Components Migration

```typescript
// Before: Simple UI component
class SimpleWidget extends Widget {
  constructor() {
    super();
    this.setupUI();
  }

  private setupUI(): void {
    this.node.innerHTML = `
      <div class="simple-widget">
        <button id="action-btn">Perform Action</button>
      </div>
    `;

    this.node.querySelector('#action-btn')!.addEventListener('click', () => {
      this.performAction();
    });
  }
}

// After: Collaboration-aware UI component
class CollaborationAwareWidget extends Widget {
  private collaborationService: ICollaborationService | null = null;

  constructor(collaborationService?: ICollaborationService) {
    super();
    this.collaborationService = collaborationService || null;
    this.setupUI();
    this.setupCollaborationFeatures();
  }

  private setupUI(): void {
    this.node.innerHTML = `
      <div class="collaboration-aware-widget">
        <button id="action-btn">Perform Action</button>
        <div class="collaboration-status" style="display: none;">
          <span class="status-indicator"></span>
          <span class="status-text">Synchronizing...</span>
        </div>
      </div>
    `;

    this.node.querySelector('#action-btn')!.addEventListener('click', () => {
      this.performCollaborativeAction();
    });
  }

  private setupCollaborationFeatures(): void {
    if (!this.collaborationService) return;

    // Show collaboration status
    const statusDiv = this.node.querySelector('.collaboration-status') as HTMLElement;
    statusDiv.style.display = 'block';

    // Subscribe to collaboration events
    this.collaborationService.getManager().signals.userPresenceChanged.connect(
      (manager, change) => {
        this.updateCollaborationStatus(change);
      }
    );
  }

  private async performCollaborativeAction(): Promise<void> {
    if (this.collaborationService) {
      // Check permissions before action
      const permissionManager = this.collaborationService.getManager().getPermissionManager();
      const canPerformAction = await permissionManager.hasPermission('write');

      if (!canPerformAction) {
        this.showPermissionError();
        return;
      }

      // Perform action with collaboration awareness
      await this.performActionWithSync();
    } else {
      // Fallback to standard action
      this.performAction();
    }
  }
}
```

#### 4. Testing Collaboration Features

```typescript
/**
 * Testing utilities for collaborative extensions
 */
class CollaborationTestUtils {
  static async createMockCollaborationService(): Promise<ICollaborationService> {
    const mockService = {
      isEnabled: true,
      state: CollaborationState.Connected,

      async getProvider(notebookPath: string): Promise<IYjsNotebookProvider> {
        const ydoc = new Y.Doc();
        return new MockYjsProvider(ydoc);
      },

      getManager(): ICollaborationManager {
        return new MockCollaborationManager();
      },

      async setEnabled(enabled: boolean): Promise<void> {
        // Mock implementation
      },

      dispose(): void {
        // Mock cleanup
      }
    };

    return mockService;
  }

  static async simulateUserPresence(
    manager: ICollaborationManager,
    users: ICollaborationUser[]
  ): Promise<void> {
    users.forEach(user => {
      manager.signals.userPresenceChanged.emit(manager, {
        type: 'joined',
        user,
        timestamp: new Date()
      });
    });
  }

  static async simulateCellEdit(
    provider: IYjsNotebookProvider,
    cellId: string,
    newContent: string
  ): Promise<void> {
    const cellsArray = provider.ydoc.getArray('cells');
    // Simulate cell content change
    // Implementation would depend on notebook model structure
  }
}

// Example test
describe('CollaborationAwareExtension', () => {
  let extension: CollaborationAwareExtension;
  let mockService: ICollaborationService;

  beforeEach(async () => {
    mockService = await CollaborationTestUtils.createMockCollaborationService();
    extension = new CollaborationAwareExtension();
  });

  it('should handle user presence changes', async () => {
    const manager = mockService.getManager();
    const testUsers = [
      { userId: '1', username: 'user1', displayName: 'User One', /* ... */ }
    ];

    // Simulate user joining
    await CollaborationTestUtils.simulateUserPresence(manager, testUsers);

    // Assert extension behavior
    // ... test assertions
  });
});
```

### Breaking Changes and Compatibility

#### 1. API Changes to Watch For

```typescript
// Old API (deprecated)
interface INotebookModel {
  cells: IObservableList<ICellModel>;
}

// New API (collaboration-aware)
interface ICollaborationNotebookModel extends INotebookModel {
  readonly collaborationProvider: IYjsNotebookProvider | null;
  readonly isCollaborating: boolean;

  // New methods
  acquireCellLock(cellId: string): Promise<boolean>;
  releaseCellLock(cellId: string): Promise<void>;
}
```

#### 2. Migration Checklist

- [ ] Update extension dependencies to include collaboration packages
- [ ] Add optional collaboration service dependency
- [ ] Implement graceful degradation when collaboration is disabled
- [ ] Update state management to use shared Yjs structures where appropriate
- [ ] Add permission checks before write operations
- [ ] Handle collaborative events in UI components
- [ ] Update tests to cover collaborative scenarios
- [ ] Review and update documentation

#### 3. Common Pitfalls and Solutions

```typescript
// ❌ Pitfall: Direct model manipulation in collaborative mode
notebook.model.cells.insert(0, cellModel);

// ✅ Solution: Check collaboration mode first
if (notebook.collaborationProvider) {
  // Use collaborative approach
  const cellsArray = notebook.collaborationProvider.ydoc.getArray('cells');
  notebook.collaborationProvider.transact(() => {
    cellsArray.insert(0, [cellModel.toJSON()]);
  });
} else {
  // Use standard approach
  notebook.model.cells.insert(0, cellModel);
}

// ❌ Pitfall: Assuming single user
this.updateUserSpecificUI();

// ✅ Solution: Handle multiple users
const users = await collaborationService.getManager().getAwareness().getUsers();
this.updateMultiUserUI(Array.from(users.values()));
```

This comprehensive API documentation provides developers with all the necessary tools, interfaces, and patterns to build robust collaboration-aware extensions for Jupyter Notebook v7. The examples demonstrate real-world usage scenarios while maintaining backward compatibility and following best practices for performance and user experience.
```
```
