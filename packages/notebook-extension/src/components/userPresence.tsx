/**
 * @fileoverview User presence component for collaborative notebook editing
 * 
 * This component displays real-time user presence awareness in collaborative notebook
 * sessions, showing active collaborators with avatars, roles, and online status indicators
 * using the Yjs awareness system. It provides visual feedback for user activity,
 * cursor positions, and collaborative interactions.
 * 
 * Key features:
 * - Real-time display of active collaborators with presence indicators
 * - Visual user avatars with role-based color coding and badges
 * - Activity status tracking (online, away, offline, idle, editing)
 * - Responsive design for varying numbers of concurrent users
 * - @mentions functionality for notifying specific collaborators
 * - Integration with AwarenessService and PermissionService
 * - Cell-level cursor position and selection visualization
 * - Accessibility support with proper ARIA attributes
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { ISignal } from '@lumino/signaling';
import { Time } from '@jupyterlab/coreutils';
import { userIcon } from '@jupyterlab/ui-components';
import { Awareness } from 'y-protocols';

import { AwarenessService } from '../../../notebook/src/collab/awareness';
import { PermissionService } from '../../../notebook/src/collab/permissions';

/**
 * Enumeration of user status states for collaborative editing
 */
export enum UserStatus {
  /** User is online and actively participating */
  ONLINE = 'online',
  /** User is away from the notebook (inactive) */
  AWAY = 'away',
  /** User is offline or disconnected */
  OFFLINE = 'offline',
  /** User is idle with no recent activity */
  IDLE = 'idle',
  /** User is actively interacting with the notebook */
  ACTIVE = 'active',
  /** User is viewing the notebook without editing */
  VIEWING = 'viewing',
  /** User is currently editing content */
  EDITING = 'editing'
}

/**
 * Enumeration of user roles for collaborative notebooks
 */
export enum UserRole {
  /** Owner with full administrative privileges */
  OWNER = 'owner',
  /** Editor with read/write access */
  EDITOR = 'editor',
  /** Viewer with read-only access */
  VIEWER = 'viewer'
}

/**
 * Interface representing comprehensive user presence data
 */
export interface IUserPresenceData {
  /** Unique identifier for the user */
  id: string;
  /** User's display name */
  name: string;
  /** User's email address */
  email: string;
  /** URL to user's avatar image */
  avatar: string;
  /** User's role in the collaborative session */
  role: UserRole;
  /** Current user status */
  status: UserStatus;
  /** Timestamp of last activity */
  lastSeen: Date;
  /** Current cursor position information */
  cursorPosition?: {
    /** ID of the cell containing the cursor */
    cellId: string;
    /** Line and column position within the cell */
    position: number;
  };
  /** ID of the cell user is currently in */
  cellId?: string;
  /** Current selection range */
  selection?: {
    /** ID of the cell containing the selection */
    cellId: string;
    /** Start position of the selection */
    start: number;
    /** End position of the selection */
    end: number;
  };
  /** Whether user is currently typing */
  isTyping: boolean;
}

/**
 * Interface for user presence component props
 */
export interface IUserPresenceProps {
  /** Awareness service for tracking user presence */
  awarenessService: AwarenessService;
  /** Permission service for managing user roles */
  permissionService: PermissionService;
  /** Translation service for internationalization */
  translator: ITranslator;
  /** Maximum number of users to display before condensing */
  maxUsers?: number;
  /** Whether to show role indicators */
  showRoles?: boolean;
  /** Whether to show activity indicators */
  showActivity?: boolean;
  /** Callback when user avatar is clicked */
  onUserClick?: (user: IUserPresenceData) => void;
  /** Callback when user is mentioned */
  onMentionUser?: (user: IUserPresenceData) => void;
}

/**
 * User presence avatar component for displaying individual users
 */
const UserAvatar: React.FC<{
  user: IUserPresenceData;
  translator: ITranslator;
  showRoles: boolean;
  showActivity: boolean;
  onClick?: (user: IUserPresenceData) => void;
}> = ({ user, translator, showRoles, showActivity, onClick }) => {
  const trans = translator.load('notebook-collaboration');
  
  const getStatusColor = (status: UserStatus): string => {
    switch (status) {
      case UserStatus.ONLINE:
      case UserStatus.ACTIVE:
      case UserStatus.EDITING:
        return '#4CAF50'; // Green
      case UserStatus.VIEWING:
        return '#2196F3'; // Blue
      case UserStatus.AWAY:
      case UserStatus.IDLE:
        return '#FFC107'; // Amber
      case UserStatus.OFFLINE:
        return '#9E9E9E'; // Gray
      default:
        return '#9E9E9E';
    }
  };

  const getRoleColor = (role: UserRole): string => {
    switch (role) {
      case UserRole.OWNER:
        return '#FF5722'; // Deep Orange
      case UserRole.EDITOR:
        return '#2196F3'; // Blue
      case UserRole.VIEWER:
        return '#4CAF50'; // Green
      default:
        return '#9E9E9E';
    }
  };

  const getStatusText = (status: UserStatus): string => {
    switch (status) {
      case UserStatus.ONLINE:
        return trans.__('Online');
      case UserStatus.ACTIVE:
        return trans.__('Active');
      case UserStatus.EDITING:
        return trans.__('Editing');
      case UserStatus.VIEWING:
        return trans.__('Viewing');
      case UserStatus.AWAY:
        return trans.__('Away');
      case UserStatus.IDLE:
        return trans.__('Idle');
      case UserStatus.OFFLINE:
        return trans.__('Offline');
      default:
        return trans.__('Unknown');
    }
  };

  const getRoleText = (role: UserRole): string => {
    switch (role) {
      case UserRole.OWNER:
        return trans.__('Owner');
      case UserRole.EDITOR:
        return trans.__('Editor');
      case UserRole.VIEWER:
        return trans.__('Viewer');
      default:
        return trans.__('Unknown');
    }
  };

  const formatLastSeen = (date: Date): string => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    
    if (minutes < 1) {
      return trans.__('Just now');
    } else if (minutes < 60) {
      return trans.__('%1 minutes ago', minutes);
    } else {
      return Time.formatHuman(date);
    }
  };

  const handleClick = () => {
    if (onClick) {
      onClick(user);
    }
  };

  const avatarStyle: React.CSSProperties = {
    position: 'relative',
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: `2px solid ${showRoles ? getRoleColor(user.role) : '#E0E0E0'}`,
    cursor: 'pointer',
    margin: '2px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F5F5F5',
    backgroundImage: user.avatar ? `url(${user.avatar})` : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    transition: 'all 0.2s ease-in-out'
  };

  const statusIndicatorStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '-2px',
    right: '-2px',
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    backgroundColor: getStatusColor(user.status),
    border: '2px solid white',
    boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
  };

  const tooltipContent = [
    `${user.name} (${user.email})`,
    showRoles && `${trans.__('Role')}: ${getRoleText(user.role)}`,
    showActivity && `${trans.__('Status')}: ${getStatusText(user.status)}`,
    `${trans.__('Last seen')}: ${formatLastSeen(user.lastSeen)}`,
    user.cellId && `${trans.__('In cell')}: ${user.cellId}`,
    user.isTyping && trans.__('Currently typing...')
  ].filter(Boolean).join('\n');

  return (
    <div
      style={avatarStyle}
      onClick={handleClick}
      title={tooltipContent}
      aria-label={`${user.name} - ${getStatusText(user.status)}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleClick();
        }
      }}
    >
      {!user.avatar && (
        <userIcon.react
          width="20px"
          height="20px"
          fill="#757575"
        />
      )}
      {showActivity && (
        <div style={statusIndicatorStyle} />
      )}
      {user.isTyping && (
        <div
          style={{
            position: 'absolute',
            top: '-8px',
            right: '-8px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            backgroundColor: '#FF9800',
            border: '2px solid white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '8px',
            fontWeight: 'bold',
            color: 'white'
          }}
        >
          ✎
        </div>
      )}
    </div>
  );
};

/**
 * Main user presence component for displaying active collaborators
 */
export const UserPresence: React.FC<IUserPresenceProps> = ({
  awarenessService,
  permissionService,
  translator,
  maxUsers = 10,
  showRoles = true,
  showActivity = true,
  onUserClick,
  onMentionUser
}) => {
  const [users, setUsers] = useState<IUserPresenceData[]>([]);
  const [currentUser, setCurrentUser] = useState<IUserPresenceData | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const trans = translator.load('notebook-collaboration');

  // Update users from awareness service
  const updateUsers = useCallback(async () => {
    try {
      const awarenessUsers = awarenessService.getUsers();
      const collaborators = await permissionService.getCollaborators();
      const currentUserInfo = awarenessService.getCurrentUser();

      // Create a map of user roles
      const roleMap = new Map<string, UserRole>();
      collaborators.forEach(collab => {
        const role = collab.role === 'admin' ? UserRole.OWNER : 
                    collab.role === 'edit' ? UserRole.EDITOR : UserRole.VIEWER;
        roleMap.set(collab.userId, role);
      });

      // Convert awareness users to presence data
      const presenceUsers: IUserPresenceData[] = awarenessUsers.map(user => ({
        id: user.userId,
        name: user.name,
        email: user.avatar?.split('@')[0] || '', // Extract email from avatar URL if available
        avatar: user.avatar || '',
        role: roleMap.get(user.userId) || UserRole.VIEWER,
        status: user.isActive ? UserStatus.ACTIVE : UserStatus.AWAY,
        lastSeen: user.lastActivity,
        cursorPosition: user.cursor ? {
          cellId: user.cursor.cellId,
          position: user.cursor.position
        } : undefined,
        cellId: user.cursor?.cellId,
        selection: user.selection ? {
          cellId: user.selection.cellId,
          start: user.selection.start,
          end: user.selection.end
        } : undefined,
        isTyping: user.isActive && Date.now() - user.lastActivity.getTime() < 3000
      }));

      // Set current user
      if (currentUserInfo) {
        const currentUserRole = roleMap.get(currentUserInfo.userId) || UserRole.VIEWER;
        setCurrentUser({
          id: currentUserInfo.userId,
          name: currentUserInfo.name,
          email: currentUserInfo.avatar?.split('@')[0] || '',
          avatar: currentUserInfo.avatar || '',
          role: currentUserRole,
          status: currentUserInfo.isActive ? UserStatus.ACTIVE : UserStatus.AWAY,
          lastSeen: new Date(),
          isTyping: false
        });
      }

      // Filter out current user from the list
      const otherUsers = presenceUsers.filter(user => user.id !== currentUserInfo?.userId);
      setUsers(otherUsers);
    } catch (error) {
      console.error('Error updating user presence:', error);
    }
  }, [awarenessService, permissionService]);

  // Set up event listeners
  useEffect(() => {
    updateUsers();

    // Listen for awareness updates
    const handleUserJoin = () => updateUsers();
    const handleUserLeave = () => updateUsers();
    const handleUserUpdate = () => updateUsers();

    awarenessService.onUserJoin.connect(handleUserJoin);
    awarenessService.onUserLeave.connect(handleUserLeave);
    awarenessService.onUserUpdate.connect(handleUserUpdate);

    // Update users periodically
    const interval = setInterval(updateUsers, 5000);

    return () => {
      awarenessService.onUserJoin.disconnect(handleUserJoin);
      awarenessService.onUserLeave.disconnect(handleUserLeave);
      awarenessService.onUserUpdate.disconnect(handleUserUpdate);
      clearInterval(interval);
    };
  }, [updateUsers, awarenessService]);

  const handleUserClick = (user: IUserPresenceData) => {
    if (onUserClick) {
      onUserClick(user);
    }
  };

  const handleMentionUser = (user: IUserPresenceData) => {
    if (onMentionUser) {
      onMentionUser(user);
    }
  };

  const displayUsers = isExpanded ? users : users.slice(0, maxUsers);
  const hiddenUsersCount = users.length - maxUsers;

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 8px',
    backgroundColor: '#FAFAFA',
    borderRadius: '6px',
    border: '1px solid #E0E0E0',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    gap: '4px',
    flexWrap: 'wrap',
    maxWidth: '400px'
  };

  const countBadgeStyle: React.CSSProperties = {
    backgroundColor: '#2196F3',
    color: 'white',
    borderRadius: '50%',
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '12px',
    fontWeight: 'bold',
    cursor: 'pointer',
    margin: '2px'
  };

  if (users.length === 0 && !currentUser) {
    return (
      <div style={containerStyle}>
        <span style={{ color: '#757575', fontSize: '12px' }}>
          {trans.__('No collaborators')}
        </span>
      </div>
    );
  }

  return (
    <div style={containerStyle} role="group" aria-label={trans.__('Active collaborators')}>
      {currentUser && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <UserAvatar
            user={currentUser}
            translator={translator}
            showRoles={showRoles}
            showActivity={showActivity}
            onClick={handleUserClick}
          />
          <span style={{ 
            fontSize: '12px', 
            color: '#757575',
            marginRight: '8px'
          }}>
            {trans.__('You')}
          </span>
        </div>
      )}
      
      {displayUsers.map(user => (
        <UserAvatar
          key={user.id}
          user={user}
          translator={translator}
          showRoles={showRoles}
          showActivity={showActivity}
          onClick={handleUserClick}
        />
      ))}

      {hiddenUsersCount > 0 && !isExpanded && (
        <div
          style={countBadgeStyle}
          onClick={() => setIsExpanded(true)}
          title={trans.__('Show %1 more collaborators', hiddenUsersCount)}
          aria-label={trans.__('Show %1 more collaborators', hiddenUsersCount)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setIsExpanded(true);
            }
          }}
        >
          +{hiddenUsersCount}
        </div>
      )}

      {isExpanded && hiddenUsersCount > 0 && (
        <div
          style={{
            ...countBadgeStyle,
            backgroundColor: '#757575'
          }}
          onClick={() => setIsExpanded(false)}
          title={trans.__('Show less')}
          aria-label={trans.__('Show less')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setIsExpanded(false);
            }
          }}
        >
          −
        </div>
      )}

      {users.length > 0 && (
        <span style={{ 
          fontSize: '12px', 
          color: '#757575',
          marginLeft: '4px'
        }}>
          {trans.__('%1 online', users.length)}
        </span>
      )}
    </div>
  );
};

/**
 * Lumino widget wrapper for the user presence component
 */
export class UserPresenceWidget extends ReactWidget {
  private _awarenessService: AwarenessService;
  private _permissionService: PermissionService;
  private _translator: ITranslator;
  private _maxUsers: number;
  private _showRoles: boolean;
  private _showActivity: boolean;
  private _onUserClick?: (user: IUserPresenceData) => void;
  private _onMentionUser?: (user: IUserPresenceData) => void;

  constructor(options: {
    awarenessService: AwarenessService;
    permissionService: PermissionService;
    translator: ITranslator;
    maxUsers?: number;
    showRoles?: boolean;
    showActivity?: boolean;
    onUserClick?: (user: IUserPresenceData) => void;
    onMentionUser?: (user: IUserPresenceData) => void;
  }) {
    super();
    this._awarenessService = options.awarenessService;
    this._permissionService = options.permissionService;
    this._translator = options.translator;
    this._maxUsers = options.maxUsers || 10;
    this._showRoles = options.showRoles !== false;
    this._showActivity = options.showActivity !== false;
    this._onUserClick = options.onUserClick;
    this._onMentionUser = options.onMentionUser;
    
    this.addClass('jp-UserPresence');
    this.title.label = 'User Presence';
    this.title.iconClass = 'jp-UserIcon';
  }

  /**
   * Create a new user presence widget
   */
  static create(options: {
    awarenessService: AwarenessService;
    permissionService: PermissionService;
    translator: ITranslator;
    maxUsers?: number;
    showRoles?: boolean;
    showActivity?: boolean;
    onUserClick?: (user: IUserPresenceData) => void;
    onMentionUser?: (user: IUserPresenceData) => void;
  }): UserPresenceWidget {
    return new UserPresenceWidget(options);
  }

  /**
   * Update the widget's configuration
   */
  update(options: Partial<{
    maxUsers: number;
    showRoles: boolean;
    showActivity: boolean;
    onUserClick: (user: IUserPresenceData) => void;
    onMentionUser: (user: IUserPresenceData) => void;
  }>): void {
    if (options.maxUsers !== undefined) {
      this._maxUsers = options.maxUsers;
    }
    if (options.showRoles !== undefined) {
      this._showRoles = options.showRoles;
    }
    if (options.showActivity !== undefined) {
      this._showActivity = options.showActivity;
    }
    if (options.onUserClick !== undefined) {
      this._onUserClick = options.onUserClick;
    }
    if (options.onMentionUser !== undefined) {
      this._onMentionUser = options.onMentionUser;
    }
    
    super.update();
  }

  /**
   * Dispose of the widget
   */
  dispose(): void {
    super.dispose();
  }

  /**
   * Render the React component
   */
  render(): JSX.Element {
    return (
      <UserPresence
        awarenessService={this._awarenessService}
        permissionService={this._permissionService}
        translator={this._translator}
        maxUsers={this._maxUsers}
        showRoles={this._showRoles}
        showActivity={this._showActivity}
        onUserClick={this._onUserClick}
        onMentionUser={this._onMentionUser}
      />
    );
  }
}