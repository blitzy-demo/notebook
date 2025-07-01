import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { INotebookTracker } from '@jupyterlab/notebook';
import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';

import React, { useState, useEffect, useCallback, useMemo } from 'react';

// Import CSS for collaboration bar styling
import '../style/collaborationBar.css';

/**
 * Token for the collaboration provider service
 */
export const ICollaborationProvider = new Token<ICollaborationProvider>(
  '@jupyterlab/collaboration:ICollaborationProvider'
);

/**
 * Token for the awareness service
 */
export const IAwarenessService = new Token<IAwarenessService>(
  '@jupyterlab/collaboration:IAwarenessService'
);

/**
 * Token for the locking service
 */
export const ILockService = new Token<ILockService>(
  '@jupyterlab/collaboration:ILockService'
);

/**
 * Token for the permissions service
 */
export const IPermissionsService = new Token<IPermissionsService>(
  '@jupyterlab/collaboration:IPermissionsService'
);

/**
 * Connection states for the collaboration session
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  SYNCHRONIZED = 'synchronized',
  ERROR = 'error'
}

/**
 * User role types for permissions
 */
export enum UserRole {
  OWNER = 'owner',
  EDITOR = 'editor',
  COMMENTER = 'commenter',
  VIEWER = 'viewer'
}

/**
 * Interface for user presence information
 */
export interface IUserPresence {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  color: string;
  role: UserRole;
  isActive: boolean;
  lastSeen: Date;
  cursor?: {
    cellId: string;
    line: number;
    column: number;
  };
}

/**
 * Interface for collaboration provider service
 */
export interface ICollaborationProvider extends IDisposable {
  /**
   * Signal emitted when connection state changes
   */
  connectionStateChanged: ISignal<ICollaborationProvider, ConnectionState>;

  /**
   * Current connection state
   */
  readonly connectionState: ConnectionState;

  /**
   * Whether the notebook is globally locked
   */
  readonly isGloballyLocked: boolean;

  /**
   * Signal emitted when global lock state changes
   */
  globalLockChanged: ISignal<ICollaborationProvider, boolean>;

  /**
   * Toggle global lock state
   */
  toggleGlobalLock(): Promise<void>;

  /**
   * Get current notebook session ID
   */
  readonly sessionId: string | null;
}

/**
 * Interface for awareness service
 */
export interface IAwarenessService extends IDisposable {
  /**
   * Signal emitted when user presence changes
   */
  presenceChanged: ISignal<IAwarenessService, IUserPresence[]>;

  /**
   * Current active users
   */
  readonly activeUsers: IUserPresence[];

  /**
   * Current user information
   */
  readonly currentUser: IUserPresence | null;

  /**
   * Get user by ID
   */
  getUser(userId: string): IUserPresence | null;
}

/**
 * Interface for lock service
 */
export interface ILockService extends IDisposable {
  /**
   * Check if notebook has any locked cells
   */
  readonly hasLockedCells: boolean;

  /**
   * Signal emitted when lock state changes
   */
  lockStateChanged: ISignal<ILockService, void>;

  /**
   * Get count of locked cells
   */
  getLockedCellCount(): number;
}

/**
 * Interface for permissions service
 */
export interface IPermissionsService extends IDisposable {
  /**
   * Current user's role
   */
  readonly currentUserRole: UserRole;

  /**
   * Signal emitted when permissions change
   */
  permissionsChanged: ISignal<IPermissionsService, void>;

  /**
   * Check if current user can perform action
   */
  canEdit(): boolean;
  canComment(): boolean;
  canManagePermissions(): boolean;
}

/**
 * Props for the CollaborationBar component
 */
interface ICollaborationBarProps {
  notebookTracker: INotebookTracker;
  translator: ITranslator;
  collaborationProvider?: ICollaborationProvider;
  awarenessService?: IAwarenessService;
  lockService?: ILockService;
  permissionsService?: IPermissionsService;
  onShowPermissions?: () => void;
  onShowHistory?: () => void;
  onShowComments?: () => void;
}

/**
 * Status indicator component for connection state
 */
const ConnectionStatus: React.FC<{
  state: ConnectionState;
  translator: ITranslator;
}> = ({ state, translator }) => {
  const trans = translator.load('notebook');
  
  const getStatusInfo = useMemo(() => {
    switch (state) {
      case ConnectionState.SYNCHRONIZED:
        return {
          icon: '🟢',
          text: trans.__('Synchronized'),
          className: 'jp-collab-status-synchronized'
        };
      case ConnectionState.CONNECTED:
        return {
          icon: '🟡',
          text: trans.__('Connected'),
          className: 'jp-collab-status-connected'
        };
      case ConnectionState.CONNECTING:
        return {
          icon: '🔄',
          text: trans.__('Connecting...'),
          className: 'jp-collab-status-connecting'
        };
      case ConnectionState.ERROR:
        return {
          icon: '🔴',
          text: trans.__('Connection Error'),
          className: 'jp-collab-status-error'
        };
      default:
        return {
          icon: '⚫',
          text: trans.__('Offline'),
          className: 'jp-collab-status-offline'
        };
    }
  }, [state, trans]);

  return (
    <div className={`jp-collab-connection-status ${getStatusInfo.className}`}>
      <span className="jp-collab-status-icon">{getStatusInfo.icon}</span>
      <span className="jp-collab-status-text">{getStatusInfo.text}</span>
    </div>
  );
};

/**
 * User avatar component
 */
const UserAvatar: React.FC<{
  user: IUserPresence;
  size?: 'small' | 'medium' | 'large';
  showName?: boolean;
  translator: ITranslator;
}> = ({ user, size = 'medium', showName = true, translator }) => {
  const trans = translator.load('notebook');
  
  const getInitials = (name: string): string => {
    return name
      .split(' ')
      .map(part => part.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const roleLabel = useMemo(() => {
    switch (user.role) {
      case UserRole.OWNER:
        return trans.__('Owner');
      case UserRole.EDITOR:
        return trans.__('Editor');
      case UserRole.COMMENTER:
        return trans.__('Commenter');
      case UserRole.VIEWER:
        return trans.__('Viewer');
      default:
        return trans.__('User');
    }
  }, [user.role, trans]);

  return (
    <div 
      className={`jp-collab-user-avatar jp-collab-avatar-${size} ${user.isActive ? 'jp-collab-avatar-active' : 'jp-collab-avatar-inactive'}`}
      title={`${user.name} (${roleLabel})`}
      style={{ borderColor: user.color }}
    >
      {user.avatar ? (
        <img 
          src={user.avatar} 
          alt={user.name}
          className="jp-collab-avatar-image"
        />
      ) : (
        <div 
          className="jp-collab-avatar-initials"
          style={{ backgroundColor: user.color }}
        >
          {getInitials(user.name)}
        </div>
      )}
      {showName && (
        <span className="jp-collab-user-name">{user.name}</span>
      )}
      {!user.isActive && (
        <div className="jp-collab-user-offline-indicator">⚫</div>
      )}
    </div>
  );
};

/**
 * Global lock toggle component
 */
const GlobalLockToggle: React.FC<{
  isLocked: boolean;
  canManage: boolean;
  onToggle: () => void;
  translator: ITranslator;
}> = ({ isLocked, canManage, onToggle, translator }) => {
  const trans = translator.load('notebook');
  
  if (!canManage) {
    return null;
  }

  return (
    <button
      className={`jp-collab-global-lock-toggle ${isLocked ? 'jp-collab-locked' : 'jp-collab-unlocked'}`}
      onClick={onToggle}
      title={isLocked ? trans.__('Unlock notebook for editing') : trans.__('Lock notebook to prevent edits')}
    >
      <span className="jp-collab-lock-icon">
        {isLocked ? '🔒' : '🔓'}
      </span>
      <span className="jp-collab-lock-text">
        {isLocked ? trans.__('Locked') : trans.__('Unlocked')}
      </span>
    </button>
  );
};

/**
 * Action buttons component
 */
const ActionButtons: React.FC<{
  onShowPermissions?: () => void;
  onShowHistory?: () => void;
  onShowComments?: () => void;
  canManagePermissions: boolean;
  hasComments: boolean;
  translator: ITranslator;
}> = ({ 
  onShowPermissions, 
  onShowHistory, 
  onShowComments, 
  canManagePermissions,
  hasComments,
  translator 
}) => {
  const trans = translator.load('notebook');

  return (
    <div className="jp-collab-action-buttons">
      {onShowHistory && (
        <button
          className="jp-collab-action-button jp-collab-history-button"
          onClick={onShowHistory}
          title={trans.__('View version history')}
        >
          <span className="jp-collab-button-icon">📜</span>
          <span className="jp-collab-button-text">{trans.__('History')}</span>
        </button>
      )}
      
      {onShowComments && (
        <button
          className={`jp-collab-action-button jp-collab-comments-button ${hasComments ? 'jp-collab-has-comments' : ''}`}
          onClick={onShowComments}
          title={trans.__('View and manage comments')}
        >
          <span className="jp-collab-button-icon">💬</span>
          <span className="jp-collab-button-text">{trans.__('Comments')}</span>
          {hasComments && (
            <span className="jp-collab-comment-indicator">●</span>
          )}
        </button>
      )}
      
      {canManagePermissions && onShowPermissions && (
        <button
          className="jp-collab-action-button jp-collab-permissions-button"
          onClick={onShowPermissions}
          title={trans.__('Manage permissions')}
        >
          <span className="jp-collab-button-icon">👥</span>
          <span className="jp-collab-button-text">{trans.__('Share')}</span>
        </button>
      )}
    </div>
  );
};

/**
 * Main CollaborationBar React component
 */
const CollaborationBarComponent: React.FC<ICollaborationBarProps> = ({
  notebookTracker,
  translator,
  collaborationProvider,
  awarenessService,
  lockService,
  permissionsService,
  onShowPermissions,
  onShowHistory,
  onShowComments
}) => {
  const trans = translator.load('notebook');
  
  // State management
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    collaborationProvider?.connectionState ?? ConnectionState.DISCONNECTED
  );
  const [activeUsers, setActiveUsers] = useState<IUserPresence[]>(
    awarenessService?.activeUsers ?? []
  );
  const [isGloballyLocked, setIsGloballyLocked] = useState<boolean>(
    collaborationProvider?.isGloballyLocked ?? false
  );
  const [hasLockedCells, setHasLockedCells] = useState<boolean>(
    lockService?.hasLockedCells ?? false
  );
  const [currentUserRole, setCurrentUserRole] = useState<UserRole>(
    permissionsService?.currentUserRole ?? UserRole.VIEWER
  );

  // Connection state handler
  useEffect(() => {
    if (!collaborationProvider) return;

    const handleConnectionChange = (sender: ICollaborationProvider, state: ConnectionState) => {
      setConnectionState(state);
    };

    const handleGlobalLockChange = (sender: ICollaborationProvider, locked: boolean) => {
      setIsGloballyLocked(locked);
    };

    collaborationProvider.connectionStateChanged.connect(handleConnectionChange);
    collaborationProvider.globalLockChanged.connect(handleGlobalLockChange);

    return () => {
      collaborationProvider.connectionStateChanged.disconnect(handleConnectionChange);
      collaborationProvider.globalLockChanged.disconnect(handleGlobalLockChange);
    };
  }, [collaborationProvider]);

  // Awareness service handler
  useEffect(() => {
    if (!awarenessService) return;

    const handlePresenceChange = (sender: IAwarenessService, users: IUserPresence[]) => {
      setActiveUsers(users);
    };

    awarenessService.presenceChanged.connect(handlePresenceChange);

    return () => {
      awarenessService.presenceChanged.disconnect(handlePresenceChange);
    };
  }, [awarenessService]);

  // Lock service handler
  useEffect(() => {
    if (!lockService) return;

    const handleLockStateChange = () => {
      setHasLockedCells(lockService.hasLockedCells);
    };

    lockService.lockStateChanged.connect(handleLockStateChange);

    return () => {
      lockService.lockStateChanged.disconnect(handleLockStateChange);
    };
  }, [lockService]);

  // Permissions service handler
  useEffect(() => {
    if (!permissionsService) return;

    const handlePermissionsChange = () => {
      setCurrentUserRole(permissionsService.currentUserRole);
    };

    permissionsService.permissionsChanged.connect(handlePermissionsChange);

    return () => {
      permissionsService.permissionsChanged.disconnect(handlePermissionsChange);
    };
  }, [permissionsService]);

  // Handle global lock toggle
  const handleGlobalLockToggle = useCallback(async () => {
    if (!collaborationProvider) return;
    
    try {
      await collaborationProvider.toggleGlobalLock();
    } catch (error) {
      console.error('Failed to toggle global lock:', error);
    }
  }, [collaborationProvider]);

  // Compute derived state
  const canManagePermissions = useMemo(() => {
    return permissionsService?.canManagePermissions() ?? false;
  }, [permissionsService, currentUserRole]);

  const canEdit = useMemo(() => {
    return permissionsService?.canEdit() ?? true;
  }, [permissionsService, currentUserRole]);

  const hasComments = useMemo(() => {
    // This would be computed from comment service when available
    return false;
  }, []);

  const displayUsers = useMemo(() => {
    // Sort users by activity and role
    return activeUsers
      .filter(user => user.isActive)
      .sort((a, b) => {
        // Sort by role priority, then by name
        const roleOrder = { [UserRole.OWNER]: 0, [UserRole.EDITOR]: 1, [UserRole.COMMENTER]: 2, [UserRole.VIEWER]: 3 };
        const roleDiff = roleOrder[a.role] - roleOrder[b.role];
        return roleDiff !== 0 ? roleDiff : a.name.localeCompare(b.name);
      });
  }, [activeUsers]);

  // Early return if no collaboration services available
  if (!collaborationProvider && !awarenessService) {
    return (
      <div className="jp-collab-bar jp-collab-bar-disabled">
        <span className="jp-collab-disabled-text">
          {trans.__('Collaboration unavailable')}
        </span>
      </div>
    );
  }

  return (
    <div className="jp-collab-bar">
      {/* Connection Status */}
      <div className="jp-collab-bar-section jp-collab-status-section">
        <ConnectionStatus
          state={connectionState}
          translator={translator}
        />
      </div>

      {/* User Presence */}
      {displayUsers.length > 0 && (
        <div className="jp-collab-bar-section jp-collab-users-section">
          <div className="jp-collab-users-container">
            {displayUsers.slice(0, 5).map(user => (
              <UserAvatar
                key={user.id}
                user={user}
                size="small"
                showName={false}
                translator={translator}
              />
            ))}
            {displayUsers.length > 5 && (
              <div className="jp-collab-users-overflow">
                <span className="jp-collab-overflow-indicator">
                  +{displayUsers.length - 5}
                </span>
              </div>
            )}
          </div>
          <div className="jp-collab-users-count">
            {trans._n('%1 user', '%1 users', displayUsers.length, displayUsers.length)}
          </div>
        </div>
      )}

      {/* Lock Controls */}
      <div className="jp-collab-bar-section jp-collab-lock-section">
        <GlobalLockToggle
          isLocked={isGloballyLocked}
          canManage={canManagePermissions}
          onToggle={handleGlobalLockToggle}
          translator={translator}
        />
        {hasLockedCells && (
          <div className="jp-collab-cell-locks-indicator">
            <span className="jp-collab-lock-icon">🔒</span>
            <span className="jp-collab-lock-count">
              {lockService?.getLockedCellCount() ?? 0}
            </span>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="jp-collab-bar-section jp-collab-actions-section">
        <ActionButtons
          onShowPermissions={onShowPermissions}
          onShowHistory={onShowHistory}
          onShowComments={onShowComments}
          canManagePermissions={canManagePermissions}
          hasComments={hasComments}
          translator={translator}
        />
      </div>
    </div>
  );
};

/**
 * Create a new CollaborationBar widget
 */
export namespace CollaborationBarComponent {
  /**
   * Options for creating a CollaborationBar
   */
  export interface IOptions {
    notebookTracker: INotebookTracker;
    translator: ITranslator;
    collaborationProvider?: ICollaborationProvider;
    awarenessService?: IAwarenessService;
    lockService?: ILockService;
    permissionsService?: IPermissionsService;
    onShowPermissions?: () => void;
    onShowHistory?: () => void;
    onShowComments?: () => void;
  }

  /**
   * Create a new CollaborationBar widget
   */
  export const create = (options: IOptions): ReactWidget => {
    return ReactWidget.create(
      <CollaborationBarComponent
        notebookTracker={options.notebookTracker}
        translator={options.translator}
        collaborationProvider={options.collaborationProvider}
        awarenessService={options.awarenessService}
        lockService={options.lockService}
        permissionsService={options.permissionsService}
        onShowPermissions={options.onShowPermissions}
        onShowHistory={options.onShowHistory}
        onShowComments={options.onShowComments}
      />
    );
  };
}

export default CollaborationBarComponent;