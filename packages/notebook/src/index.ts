/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Main entry point for the @jupyter-notebook/notebook package with comprehensive
 * collaborative editing features. This module provides a unified API for:
 *
 * - Enhanced NotebookModel with Yjs CRDT integration for real-time collaboration
 * - Modified NotebookPanel widget with user presence tracking and awareness
 * - Cell operations with distributed locking mechanisms for conflict prevention
 * - Complete collaboration infrastructure including providers, permissions, and history
 * - Extended interfaces and tokens for dependency injection and plugin development
 *
 * The API maintains backward compatibility with single-user scenarios while providing
 * robust multi-user collaborative editing capabilities when collaboration is enabled.
 */

// Core notebook components with collaboration enhancements
export { NotebookModel } from './model';
export { NotebookPanel } from './widget';
export { CellOperations } from './celloperations';

// Collaboration interfaces and tokens for dependency injection
export * from './tokens';

// Collaboration core infrastructure
export { YjsNotebookProvider } from './collab/provider';
export { CollaborationAwareness } from './collab/awareness';
export { CellLockManager } from './collab/locks';
export { HistoryTracker } from './collab/history';
export { PermissionManager } from './collab/permissions';
export { CommentStore } from './collab/comments';

// Re-export collaboration types and utilities for plugin developers
export type {
  ICollaborativeUser,
  ICollaborativeSession,
  IVersionSnapshot,
  IComment,
  ICellLockStatus,
  CollaborativeRole
} from './tokens';

// Re-export collaboration enums for external use
export {
  CollaborativeRole
} from './tokens';

// Re-export configuration interfaces for setup
export type {
  IProviderConfig,
  IProviderTelemetry
} from './collab/provider';

export type {
  IAwarenessConfig
} from './collab/awareness';

export type {
  ILockConfig
} from './collab/locks';

export type {
  IHistoryConfig,
  IDiffResult,
  IRestoreResult
} from './collab/history';

export type {
  IPermissionConfig,
  IPermissionAuditLog
} from './collab/permissions';

export type {
  ICommentConfig,
  ICommentNotification,
  ICommentThread
} from './collab/comments';

// Re-export error classes for proper error handling
export {
  LockError,
  LockErrorCode
} from './collab/locks';

export {
  PermissionError
} from './collab/permissions';

export {
  CommentError,
  CommentStatus
} from './collab/comments';

// Re-export user color enumeration for UI consistency
export {
  UserColor,
  DEFAULT_PRESENCE_TIMEOUT_MS,
  MAX_PRESENCE_BACKOFF_MS
} from './collab/awareness';

// Re-export lock timeouts and constants
export {
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_QUEUE_TIMEOUT_MS
} from './collab/locks';

// Re-export history constants
export {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  MAX_HISTORY_SNAPSHOTS
} from './collab/history';

// Re-export permission constants
export {
  DEFAULT_PERMISSION_CACHE_TTL_MS,
  DEFAULT_JUPYTERHUB_API_TIMEOUT_MS
} from './collab/permissions';

// Re-export comment constants
export {
  DEFAULT_COMMENT_TIMEOUT_MS
} from './collab/comments';

/**
 * Version information for the collaboration package
 */
export const COLLABORATION_VERSION = '1.0.0';

/**
 * Feature flags for collaboration capabilities
 */
export const COLLABORATION_FEATURES = {
  /**
   * Real-time document synchronization using Yjs CRDT
   */
  REAL_TIME_SYNC: true,

  /**
   * User presence awareness and cursor tracking
   */
  PRESENCE_AWARENESS: true,

  /**
   * Cell-level locking for conflict prevention
   */
  CELL_LOCKING: true,

  /**
   * Version history and diff capabilities
   */
  VERSION_HISTORY: true,

  /**
   * Role-based permission management
   */
  PERMISSIONS: true,

  /**
   * Collaborative commenting and reviews
   */
  COMMENTS: true,

  /**
   * JupyterHub integration for authentication
   */
  JUPYTERHUB_INTEGRATION: true,

  /**
   * Offline support with eventual consistency
   */
  OFFLINE_SUPPORT: false, // Reserved for future implementation

  /**
   * Peer-to-peer collaboration without server
   */
  P2P_COLLABORATION: false // Reserved for future implementation
} as const;

/**
 * Utility function to check if collaboration is supported in the current environment
 */
export function isCollaborationSupported(): boolean {
  // Check for required browser APIs
  if (typeof WebSocket === 'undefined') {
    return false;
  }

  if (typeof SharedArrayBuffer === 'undefined') {
    console.warn('SharedArrayBuffer not available - some collaboration features may be limited');
  }

  return true;
}

/**
 * Utility function to get collaboration feature availability
 */
export function getCollaborationCapabilities(): Record<string, boolean> {
  const isSupported = isCollaborationSupported();

  return Object.fromEntries(
    Object.entries(COLLABORATION_FEATURES).map(([key, value]) => [
      key,
      isSupported && value
    ])
  );
}

/**
 * Initialize collaboration infrastructure with default configuration
 *
 * @param options - Configuration options for collaboration setup
 * @returns Promise resolving to initialized collaboration components
 */
export async function initializeCollaboration(options: {
  /**
   * WebSocket server URL for collaboration
   */
  websocketUrl?: string;

  /**
   * JupyterHub API URL for authentication
   */
  jupyterHubApiUrl?: string;

  /**
   * Enable single-user mode bypass
   */
  singleUserMode?: boolean;

  /**
   * Custom configuration for individual components
   */
  providerConfig?: Partial<any>;
  awarenessConfig?: Partial<any>;
  lockConfig?: Partial<any>;
  historyConfig?: Partial<any>;
  permissionConfig?: Partial<any>;
  commentConfig?: Partial<any>;
} = {}): Promise<{
  provider: YjsNotebookProvider | null;
  awareness: CollaborationAwareness | null;
  lockManager: CellLockManager | null;
  historyTracker: HistoryTracker | null;
  permissionManager: PermissionManager | null;
  commentStore: CommentStore | null;
}> {

  if (!isCollaborationSupported()) {
    console.warn('Collaboration not supported in this environment');
    return {
      provider: null,
      awareness: null,
      lockManager: null,
      historyTracker: null,
      permissionManager: null,
      commentStore: null
    };
  }

  try {
    // Initialize awareness first (can work without provider)
    const awareness = new CollaborationAwareness(options.awarenessConfig || {});

    // Initialize permission manager
    const permissionManager = new PermissionManager({
      jupyterHubApiUrl: options.jupyterHubApiUrl,
      singleUserMode: options.singleUserMode,
      ...options.permissionConfig
    });

    let provider: YjsNotebookProvider | null = null;
    let lockManager: CellLockManager | null = null;
    let historyTracker: HistoryTracker | null = null;
    let commentStore: CommentStore | null = null;

    // Initialize provider if WebSocket URL is available
    if (options.websocketUrl) {
      provider = new YjsNotebookProvider({
        websocketUrl: options.websocketUrl,
        ...options.providerConfig
      });

      // Connect awareness to provider
      awareness.initializeAwareness(provider);
      permissionManager.initialize(provider);

      // Initialize lock manager with provider and awareness
      lockManager = new CellLockManager(
        provider,
        awareness,
        options.lockConfig || {}
      );

      // Initialize history tracker
      historyTracker = new HistoryTracker(
        provider,
        options.historyConfig || {}
      );

      // Initialize comment store
      commentStore = new CommentStore(
        provider,
        permissionManager,
        awareness,
        options.commentConfig || {}
      );
    }

    return {
      provider,
      awareness,
      lockManager,
      historyTracker,
      permissionManager,
      commentStore
    };

  } catch (error) {
    console.error('Failed to initialize collaboration infrastructure:', error);
    throw error;
  }
}

/**
 * Gracefully dispose of collaboration infrastructure
 */
export function disposeCollaboration(components: {
  provider?: YjsNotebookProvider | null;
  awareness?: CollaborationAwareness | null;
  lockManager?: CellLockManager | null;
  historyTracker?: HistoryTracker | null;
  permissionManager?: PermissionManager | null;
  commentStore?: CommentStore | null;
}): void {

  try {
    // Dispose in reverse dependency order
    if (components.commentStore) {
      components.commentStore.cleanup();
    }

    if (components.historyTracker) {
      components.historyTracker.dispose();
    }

    if (components.lockManager) {
      components.lockManager.dispose();
    }

    if (components.permissionManager) {
      components.permissionManager.dispose();
    }

    if (components.awareness) {
      components.awareness.cleanup();
    }

    if (components.provider) {
      components.provider.dispose();
    }

    console.log('Collaboration infrastructure disposed successfully');

  } catch (error) {
    console.error('Error during collaboration cleanup:', error);
  }
}
