import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { 
  ICollaborationService,
  IAwarenessSystem,
  ICollaborationPermissions
} from '@jupyter-notebook/application';
import React, { useEffect, useState, useCallback, useMemo } from 'react';

/**
 * Interface for user presence information
 */
interface IUserPresence {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  role: 'view' | 'edit' | 'admin';
  isActive: boolean;
  lastSeen: Date;
  cursorPosition?: {
    cellId: string;
    offset: number;
  };
  activeCell?: string;
  color: string;
}

/**
 * Interface for collaboration status
 */
interface ICollaborationStatus {
  isConnected: boolean;
  connectionQuality: 'excellent' | 'good' | 'poor' | 'offline';
  latency: number;
  userCount: number;
  roomId: string;
  startTime: Date;
}

/**
 * Props for the CollaborationToolbar component
 */
interface ICollaborationToolbarProps {
  translator: ITranslator;
  awarenessSystem: IAwarenessSystem | null;
  permissions: ICollaborationPermissions | null;
  collaborationService: ICollaborationService | null;
}

/**
 * Generate a consistent color for a user based on their userId
 */
const generateUserColor = (userId: string): string => {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57',
    '#FF9FF3', '#54A0FF', '#5F27CD', '#00D2D3', '#FF9F43',
    '#EE5A24', '#0ABDE3', '#3742FA', '#2F3542', '#57606F'
  ];
  
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return colors[Math.abs(hash) % colors.length];
};

/**
 * User avatar component with presence indicator
 */
const UserAvatar = ({ user, size = 32 }: { user: IUserPresence; size?: number }): JSX.Element => {
  const initials = user.displayName
    .split(' ')
    .map(name => name.charAt(0).toUpperCase())
    .slice(0, 2)
    .join('');

  return (
    <div
      className="jp-CollaborationToolbar-userAvatar"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: user.color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.floor(size * 0.4),
        fontWeight: 600,
        color: 'white',
        position: 'relative',
        cursor: 'pointer',
        border: user.isActive ? `2px solid ${user.color}` : '2px solid transparent',
        boxShadow: user.isActive ? `0 0 0 2px rgba(${parseInt(user.color.slice(1, 3), 16)}, ${parseInt(user.color.slice(3, 5), 16)}, ${parseInt(user.color.slice(5, 7), 16)}, 0.3)` : 'none'
      }}
      title={`${user.displayName} (${user.role}) - ${user.isActive ? 'Active' : `Last seen: ${user.lastSeen.toLocaleTimeString()}`}`}
    >
      {user.avatarUrl ? (
        <img
          src={user.avatarUrl}
          alt={user.displayName}
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            objectFit: 'cover'
          }}
        />
      ) : (
        initials
      )}
      
      {/* Activity indicator */}
      <div
        className="jp-CollaborationToolbar-activityIndicator"
        style={{
          position: 'absolute',
          bottom: -2,
          right: -2,
          width: size * 0.3,
          height: size * 0.3,
          borderRadius: '50%',
          backgroundColor: user.isActive ? '#4CAF50' : '#757575',
          border: '2px solid white',
          animation: user.isActive ? 'pulse 2s infinite' : 'none'
        }}
      />
      
      {/* Role indicator */}
      <div
        className="jp-CollaborationToolbar-roleIndicator"
        style={{
          position: 'absolute',
          top: -2,
          right: -2,
          width: size * 0.25,
          height: size * 0.25,
          borderRadius: '50%',
          backgroundColor: user.role === 'admin' ? '#F44336' : user.role === 'edit' ? '#2196F3' : '#FF9800',
          border: '1px solid white',
          fontSize: Math.floor(size * 0.15),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white'
        }}
        title={`Role: ${user.role}`}
      >
        {user.role === 'admin' ? 'A' : user.role === 'edit' ? 'E' : 'V'}
      </div>
    </div>
  );
};

/**
 * Connection status indicator component
 */
const ConnectionStatus = ({ status, translator }: { status: ICollaborationStatus; translator: ITranslator }): JSX.Element => {
  const trans = translator.load('notebook');
  
  const getStatusColor = () => {
    switch (status.connectionQuality) {
      case 'excellent': return '#4CAF50';
      case 'good': return '#8BC34A';
      case 'poor': return '#FF9800';
      case 'offline': return '#F44336';
      default: return '#757575';
    }
  };

  const getStatusText = () => {
    if (!status.isConnected) return trans.__('Offline');
    
    switch (status.connectionQuality) {
      case 'excellent': return trans.__('Excellent');
      case 'good': return trans.__('Good');
      case 'poor': return trans.__('Poor');
      default: return trans.__('Unknown');
    }
  };

  return (
    <div
      className="jp-CollaborationToolbar-connectionStatus"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '12px',
        backgroundColor: 'rgba(0, 0, 0, 0.05)',
        fontSize: '12px',
        fontWeight: 500
      }}
      title={status.isConnected 
        ? trans.__('Connected - Latency: %1ms, Users: %2', status.latency, status.userCount)
        : trans.__('Disconnected from collaboration server')
      }
    >
      <div
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: getStatusColor(),
          animation: status.isConnected ? 'pulse 2s infinite' : 'none'
        }}
      />
      <span>{getStatusText()}</span>
      {status.isConnected && (
        <span style={{ color: '#666', marginLeft: '4px' }}>
          {status.userCount} {status.userCount === 1 ? trans.__('user') : trans.__('users')}
        </span>
      )}
    </div>
  );
};

/**
 * Main CollaborationToolbar React component
 */
const CollaborationToolbar = ({
  translator,
  awarenessSystem,
  permissions,
  collaborationService
}: ICollaborationToolbarProps): JSX.Element => {
  const trans = translator.load('notebook');
  
  // State management
  const [users, setUsers] = useState<IUserPresence[]>([]);
  const [status, setStatus] = useState<ICollaborationStatus>({
    isConnected: false,
    connectionQuality: 'offline',
    latency: 0,
    userCount: 0,
    roomId: '',
    startTime: new Date()
  });
  const [isExpanded, setIsExpanded] = useState(false);

  // Memoized user processing for performance
  const processedUsers = useMemo(() => {
    // Limit displayed users to prevent UI overflow
    const maxDisplayedUsers = 10;
    const activeUsers = users.filter(user => user.isActive).slice(0, maxDisplayedUsers);
    const inactiveUsers = users.filter(user => !user.isActive).slice(0, maxDisplayedUsers - activeUsers.length);
    
    return [...activeUsers, ...inactiveUsers];
  }, [users]);

  // Update collaboration status
  const updateStatus = useCallback(() => {
    if (!collaborationService) return;

    const session = collaborationService.getCurrentSession();
    const connectionState = collaborationService.getConnectionState();
    
    setStatus({
      isConnected: connectionState.isConnected,
      connectionQuality: connectionState.quality,
      latency: connectionState.latency,
      userCount: session?.userCount || 0,
      roomId: session?.roomId || '',
      startTime: session?.startTime || new Date()
    });
  }, [collaborationService]);

  // Update user presence information
  const updateUserPresence = useCallback(() => {
    if (!awarenessSystem) return;

    const awarenessMap = awarenessSystem.getStates();
    const currentUsers: IUserPresence[] = [];

    awarenessMap.forEach((state, userId) => {
      if (state.user) {
        const userPermission = permissions?.getUserPermissions(userId);
        
        currentUsers.push({
          userId,
          username: state.user.name || `User${userId.slice(0, 8)}`,
          displayName: state.user.displayName || state.user.name || `User ${userId.slice(0, 8)}`,
          avatarUrl: state.user.avatar,
          role: userPermission?.role || 'view',
          isActive: Date.now() - (state.lastUpdate || 0) < 30000, // 30 seconds threshold
          lastSeen: new Date(state.lastUpdate || 0),
          cursorPosition: state.cursor ? {
            cellId: state.cursor.cellId,
            offset: state.cursor.offset
          } : undefined,
          activeCell: state.activeCell,
          color: generateUserColor(userId)
        });
      }
    });

    // Sort users: active first, then by role (admin > edit > view), then by display name
    currentUsers.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      
      const roleOrder = { admin: 0, edit: 1, view: 2 };
      if (roleOrder[a.role] !== roleOrder[b.role]) {
        return roleOrder[a.role] - roleOrder[b.role];
      }
      
      return a.displayName.localeCompare(b.displayName);
    });

    setUsers(currentUsers);
  }, [awarenessSystem, permissions]);

  // Effect for monitoring collaboration state and user presence
  useEffect(() => {
    if (!collaborationService || !awarenessSystem) return;

    // Initial update
    updateStatus();
    updateUserPresence();

    // Set up event listeners
    const statusInterval = setInterval(updateStatus, 2000); // Update every 2 seconds
    const presenceInterval = setInterval(updateUserPresence, 1000); // Update every 1 second

    // Cleanup listeners
    return () => {
      clearInterval(statusInterval);
      clearInterval(presenceInterval);
    };
  }, [collaborationService, awarenessSystem, updateStatus, updateUserPresence]);

  // Handle collaboration controls
  const handleCollaborationToggle = useCallback(() => {
    if (!collaborationService) return;

    if (status.isConnected) {
      collaborationService.disconnect();
    } else {
      collaborationService.connect();
    }
  }, [collaborationService, status.isConnected]);

  const handlePermissionManagement = useCallback(() => {
    if (!permissions || !permissions.canPerformOperation('manage_users')) return;
    
    // This would trigger opening the permission dialog
    // Implementation would be handled by the permission dialog component
    console.log('Opening permission management dialog');
  }, [permissions]);

  // Don't render if collaboration is not available or not enabled
  if (!collaborationService || !collaborationService.isCollaborationEnabled()) {
    return <div></div>;
  }

  return (
    <div className="jp-CollaborationToolbar">
      <style>
        {`
          .jp-CollaborationToolbar {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 6px 12px;
            border-radius: 6px;
            background-color: rgba(255, 255, 255, 0.95);
            border: 1px solid rgba(0, 0, 0, 0.1);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            font-family: var(--jp-ui-font-family);
            min-height: 40px;
            max-width: 600px;
            overflow: hidden;
          }
          
          .jp-CollaborationToolbar-users {
            display: flex;
            align-items: center;
            gap: 6px;
            max-width: 320px;
            overflow: hidden;
          }
          
          .jp-CollaborationToolbar-moreUsers {
            background-color: rgba(0, 0, 0, 0.1);
            color: #666;
            border-radius: 50%;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
          }
          
          .jp-CollaborationToolbar-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-left: auto;
          }
          
          .jp-CollaborationToolbar-button {
            padding: 4px 8px;
            border: 1px solid rgba(0, 0, 0, 0.2);
            border-radius: 4px;
            background-color: white;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.2s ease;
          }
          
          .jp-CollaborationToolbar-button:hover {
            background-color: rgba(0, 0, 0, 0.05);
          }
          
          .jp-CollaborationToolbar-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          
          @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
          }
        `}
      </style>
      
      {/* Connection Status */}
      <ConnectionStatus status={status} translator={translator} />
      
      {/* User Presence Indicators */}
      <div className="jp-CollaborationToolbar-users">
        {processedUsers.slice(0, isExpanded ? 20 : 8).map((user) => (
          <UserAvatar key={user.userId} user={user} size={32} />
        ))}
        
        {users.length > (isExpanded ? 20 : 8) && (
          <div
            className="jp-CollaborationToolbar-moreUsers"
            onClick={() => setIsExpanded(!isExpanded)}
            title={trans.__('Show %1 more users', users.length - (isExpanded ? 20 : 8))}
          >
            +{users.length - (isExpanded ? 20 : 8)}
          </div>
        )}
      </div>
      
      {/* Collaboration Controls */}
      <div className="jp-CollaborationToolbar-controls">
        {permissions && permissions.canPerformOperation('manage_users') && (
          <button
            className="jp-CollaborationToolbar-button"
            onClick={handlePermissionManagement}
            title={trans.__('Manage collaboration permissions')}
          >
            {trans.__('Permissions')}
          </button>
        )}
        
        <button
          className="jp-CollaborationToolbar-button"
          onClick={handleCollaborationToggle}
          title={status.isConnected 
            ? trans.__('Disconnect from collaboration') 
            : trans.__('Connect to collaboration')
          }
        >
          {status.isConnected ? trans.__('Disconnect') : trans.__('Connect')}
        </button>
      </div>
    </div>
  );
};

/**
 * A namespace for CollaborationToolbar static methods.
 */
export namespace CollaborationToolbar {
  /**
   * Create a new CollaborationToolbar widget
   *
   * @param props The component props
   */
  export const create = (props: ICollaborationToolbarProps): ReactWidget => {
    return ReactWidget.create(
      <CollaborationToolbar {...props} />
    );
  };
}

/**
 * Export the CollaborationToolbar component and namespace
 */
export { CollaborationToolbar };