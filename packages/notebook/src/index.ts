// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Main entry point for the @jupyter-notebook/notebook package.
 * 
 * This module provides a unified API surface for collaborative notebook components
 * including the enhanced NotebookModel and NotebookPanel with real-time collaboration
 * capabilities, user awareness, cell locking, change history, permissions, and comments.
 * 
 * The package integrates Yjs CRDT framework for conflict-free collaborative editing
 * and provides comprehensive interfaces for external integration with other Jupyter components.
 */

// Core notebook components with collaboration capabilities
export { default as NotebookModel } from './model';
export { default as NotebookPanel } from './widget';

// Collaboration service components
export { default as YjsNotebookProvider } from './collab/provider';
export { default as UserAwareness } from './collab/awareness';
export { default as CellLocking } from './collab/locks';
export { default as ChangeHistory } from './collab/history';
export { default as PermissionsSystem } from './collab/permissions';
export { default as CommentSystem } from './collab/comments';

// Interfaces for collaboration management
export { IChangeHistory, IVersionProvider } from './collab/history';
export { IPermissionsManager, ICollaborativeRole } from './collab/permissions';

// Core collaboration interfaces from model
export { ICollaborationManager, ICollaborativeNotebook } from './model';

// Enumerations and types for collaboration states
export { CollaborationState, SyncState } from './model';
export { CollaborationConnectionState, SyncState as PanelSyncState } from './widget';
export { ConnectionStatus, SyncStatus } from './collab/provider';
export { UserActivityType, AwarenessEventType } from './collab/awareness';
export { LockState, LockType, LockEventType } from './collab/locks';
export { ChangeType, VersionStatus } from './collab/history';
export { PermissionLevel, PermissionAction } from './collab/permissions';
export { CommentStatus, CommentPermission, CommentEventType } from './collab/comments';

// Additional interfaces for external integration
export { IDocumentUpdateEvent, IProviderConfig } from './collab/provider';
export { ICursorPosition, ISelection, IUser } from './collab/awareness';
export { ICellLock, ILockEvent } from './collab/locks';
export { IVersionMetadata, IChangeSet, IChangeEvent } from './collab/history';
export { IPermissionGrant, IUserContext, IPermissionContext } from './collab/permissions';
export { IComment, ICommentThread, ICommentNotification } from './collab/comments';

// Utility types for collaboration configuration
export { ICollaborationState } from './model';