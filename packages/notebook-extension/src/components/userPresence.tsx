/**
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

/**
 * Interface for user awareness state according to Yjs awareness protocol
 */
export interface IUserAwarenessState {
  /** Unique user identifier */
  readonly userId: string;
  /** Display name for the user */
  readonly displayName: string;
  /** User's avatar URL or initials */
  readonly avatar?: string;
  /** Current activity status */
  readonly status: 'active' | 'idle' | 'away' | 'busy';
  /** User's current cursor position if editing */
  readonly cursor?: {
    readonly cellId: string;
    readonly position: number;
    readonly selection?: {
      readonly anchor: number;
      readonly head: number;
    };
  };
  /** Timestamp of last activity */
  readonly lastActivity: number;
  /** User's role in the collaboration session */
  readonly role?: 'owner' | 'editor' | 'viewer';
  /** Color assigned to this user for presence indicators */
  readonly color: string;
}

/**
 * Interface for the awareness service that provides user presence data
 */
export interface IAwarenessService {
  /** Yjs awareness instance for real-time presence tracking */
  readonly awareness: Awareness;
  /** Get current user's awareness state */
  readonly localState: IUserAwarenessState | null;
  /** Get all remote users' awareness states */
  readonly remoteStates: Map<number, IUserAwarenessState>;
  /** Signal emitted when awareness states change */
  readonly statesChanged: any; // Lumino signal
  /** Update local user's awareness state */
  updateLocalState(state: Partial<IUserAwarenessState>): void;
  /** Get awareness state for a specific client ID */
  getState(clientId: number): IUserAwarenessState | null;
  /** Check if collaboration is currently connected */
  readonly isConnected: boolean;
  /** Dispose of the service */
  dispose(): void;
}

/**
 * Props for the UserPresence React component
 */
interface IUserPresenceProps {
  /** Awareness service for tracking user presence */
  awarenessService: IAwarenessService;
  /** Notebook tracker for context */
  tracker: INotebookTracker;
  /** Translation service */
  translator: ITranslator;
  /** Maximum number of avatars to display before showing overflow */
  maxAvatars?: number;
  /** Whether to show detailed status information */
  showDetailedStatus?: boolean;
  /** Custom CSS class name */
  className?: string;
}

/**
 * Hook for managing user presence state updates
 */
const useUserPresence = (awarenessService: IAwarenessService) => {
  const [localState, setLocalState] = useState<IUserAwarenessState | null>(
    awarenessService.localState
  );
  const [remoteStates, setRemoteStates] = useState<Map<number, IUserAwarenessState>>(
    new Map(awarenessService.remoteStates)
  );
  const [isConnected, setIsConnected] = useState<boolean>(awarenessService.isConnected);
  const [lastUpdate, setLastUpdate] = useState<number>(Date.now());

  const handleStatesChanged = useCallback(() => {
    setLocalState(awarenessService.localState);
    setRemoteStates(new Map(awarenessService.remoteStates));
    setIsConnected(awarenessService.isConnected);
    setLastUpdate(Date.now());
  }, [awarenessService]);

  useEffect(() => {
    // Connect to awareness state changes
    awarenessService.statesChanged?.connect(handleStatesChanged);

    // Update local activity timestamp periodically
    const activityInterval = setInterval(() => {
      if (awarenessService.localState && isConnected) {
        awarenessService.updateLocalState({
          lastActivity: Date.now(),
          status: document.hasFocus() ? 'active' : 'idle'
        });
      }
    }, 30000); // Update every 30 seconds

    // Handle visibility changes for status updates
    const handleVisibilityChange = () => {
      if (awarenessService.localState) {
        awarenessService.updateLocalState({
          status: document.hidden ? 'away' : 'active',
          lastActivity: Date.now()
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      awarenessService.statesChanged?.disconnect(handleStatesChanged);
      clearInterval(activityInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [awarenessService, handleStatesChanged, isConnected]);

  return {
    localState,
    remoteStates,
    isConnected,
    lastUpdate
  };
};

/**
 * Utility function to generate avatar content
 */
const getAvatarContent = (user: IUserAwarenessState): string => {
  if (user.avatar && user.avatar.startsWith('http')) {
    return user.avatar;
  }
  
  // Generate initials from display name
  const words = user.displayName.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return words[0]?.substring(0, 2).toUpperCase() || '??';
};

/**
 * Utility function to determine status icon
 */
const getStatusIcon = (status: IUserAwarenessState['status']): string => {
  switch (status) {
    case 'active': return '🟢';
    case 'idle': return '🟡';
    case 'away': return '⚫';
    case 'busy': return '🔴';
    default: return '⚪';
  }
};

/**
 * Utility function to format last activity time
 */
const formatLastActivity = (timestamp: number, translator: ITranslator): string => {
  const trans = translator.load('notebook');
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) { // Less than 1 minute
    return trans.__('Active now');
  } else if (diff < 3600000) { // Less than 1 hour
    const minutes = Math.floor(diff / 60000);
    return trans.__('%1 min ago', minutes);
  } else if (diff < 86400000) { // Less than 1 day
    const hours = Math.floor(diff / 3600000);
    return trans.__('%1 hr ago', hours);
  } else {
    const days = Math.floor(diff / 86400000);
    return trans.__('%1 days ago', days);
  }
};

/**
 * User Avatar component for displaying individual user presence
 */
const UserAvatar: React.FC<{
  user: IUserAwarenessState;
  size?: 'small' | 'medium' | 'large';
  showStatus?: boolean;
  showTooltip?: boolean;
  translator: ITranslator;
  onClick?: () => void;
}> = ({ user, size = 'medium', showStatus = true, showTooltip = true, translator, onClick }) => {
  const [showDetails, setShowDetails] = useState(false);
  const trans = translator.load('notebook');
  
  const sizeClasses = {
    small: 'jp-UserPresence-avatar-small',
    medium: 'jp-UserPresence-avatar-medium', 
    large: 'jp-UserPresence-avatar-large'
  };

  const avatarContent = getAvatarContent(user);
  const isImageUrl = avatarContent.startsWith('http');
  
  const handleClick = useCallback(() => {
    if (onClick) {
      onClick();
    } else if (showTooltip) {
      setShowDetails(!showDetails);
    }
  }, [onClick, showTooltip, showDetails]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  }, [handleClick]);

  return (
    <div className="jp-UserPresence-avatarContainer">
      <div
        className={`jp-UserPresence-avatar ${sizeClasses[size]}`}
        style={{
          borderColor: user.color,
          backgroundColor: isImageUrl ? 'transparent' : user.color
        }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-label={trans.__('User %1 (%2)', user.displayName, user.status)}
        title={showTooltip ? `${user.displayName} - ${user.status}` : undefined}
      >
        {isImageUrl ? (
          <img
            src={avatarContent}
            alt={user.displayName}
            className="jp-UserPresence-avatarImage"
          />
        ) : (
          <span className="jp-UserPresence-avatarInitials">{avatarContent}</span>
        )}
        
        {showStatus && (
          <div className="jp-UserPresence-statusIndicator">
            <span 
              className="jp-UserPresence-statusIcon"
              role="img"
              aria-label={user.status}
            >
              {getStatusIcon(user.status)}
            </span>
          </div>
        )}
      </div>

      {showDetails && showTooltip && (
        <div className="jp-UserPresence-tooltip">
          <div className="jp-UserPresence-tooltipContent">
            <div className="jp-UserPresence-tooltipName">{user.displayName}</div>
            <div className="jp-UserPresence-tooltipStatus">
              {trans.__('Status: %1', user.status)}
            </div>
            {user.role && (
              <div className="jp-UserPresence-tooltipRole">
                {trans.__('Role: %1', user.role)}
              </div>
            )}
            <div className="jp-UserPresence-tooltipActivity">
              {formatLastActivity(user.lastActivity, translator)}
            </div>
            {user.cursor && (
              <div className="jp-UserPresence-tooltipCursor">
                {trans.__('Editing cell: %1', user.cursor.cellId.substring(0, 8))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Main UserPresence React component
 */
const UserPresence: React.FC<IUserPresenceProps> = ({
  awarenessService,
  tracker,
  translator,
  maxAvatars = 5,
  showDetailedStatus = false,
  className = ''
}) => {
  const { localState, remoteStates, isConnected } = useUserPresence(awarenessService);
  const trans = translator.load('notebook');

  // Memoized computation of user list with proper sorting
  const { displayUsers, overflowCount } = useMemo(() => {
    const allUsers = Array.from(remoteStates.values());
    
    // Sort users by activity (most recent first), then by status, then by name
    allUsers.sort((a, b) => {
      // Active users first
      const statusOrder = { active: 0, busy: 1, idle: 2, away: 3 };
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;
      
      // Then by last activity (most recent first)
      const activityDiff = b.lastActivity - a.lastActivity;
      if (activityDiff !== 0) return activityDiff;
      
      // Finally by name alphabetically
      return a.displayName.localeCompare(b.displayName);
    });

    const displayUsers = allUsers.slice(0, maxAvatars);
    const overflowCount = Math.max(0, allUsers.length - maxAvatars);

    return { displayUsers, overflowCount };
  }, [remoteStates, maxAvatars]);

  // Handle connection status changes
  const connectionStatusText = useMemo(() => {
    if (!isConnected) {
      return trans.__('Collaboration disconnected');
    }
    
    const totalUsers = remoteStates.size + (localState ? 1 : 0);
    if (totalUsers === 1) {
      return trans.__('You are the only one here');
    } else if (totalUsers === 2) {
      return trans.__('1 other person');
    } else {
      return trans.__('%1 other people', totalUsers - 1);
    }
  }, [isConnected, remoteStates.size, localState, trans]);

  // Error boundary for avatar rendering
  const renderAvatar = useCallback((user: IUserAwarenessState, index: number) => {
    try {
      return (
        <UserAvatar
          key={`user-${user.userId}-${index}`}
          user={user}
          size="medium"
          showStatus={true}
          showTooltip={true}
          translator={translator}
        />
      );
    } catch (error) {
      console.error('Error rendering user avatar:', error);
      return (
        <div key={`error-${index}`} className="jp-UserPresence-avatarError">
          <span title={trans.__('Error loading user avatar')}>⚠️</span>
        </div>
      );
    }
  }, [translator, trans]);

  // Don't render if no awareness service or no users
  if (!awarenessService || (!isConnected && remoteStates.size === 0)) {
    return null;
  }

  return (
    <div className={`jp-UserPresence ${className}`} role="region" aria-label={trans.__('User Presence')}>
      <div className="jp-UserPresence-container">
        {/* Connection status indicator */}
        <div className={`jp-UserPresence-status ${isConnected ? 'connected' : 'disconnected'}`}>
          <span
            className="jp-UserPresence-statusIcon"
            role="img"
            aria-label={isConnected ? trans.__('Connected') : trans.__('Disconnected')}
          >
            {isConnected ? '🟢' : '🔴'}
          </span>
          {showDetailedStatus && (
            <span className="jp-UserPresence-statusText">
              {connectionStatusText}
            </span>
          )}
        </div>

        {/* User avatars */}
        {isConnected && displayUsers.length > 0 && (
          <div className="jp-UserPresence-users" role="list">
            {displayUsers.map(renderAvatar)}
            
            {/* Overflow indicator */}
            {overflowCount > 0 && (
              <div 
                className="jp-UserPresence-overflow"
                role="listitem"
                aria-label={trans.__('%1 more users', overflowCount)}
                title={trans.__('%1 more users', overflowCount)}
              >
                <span className="jp-UserPresence-overflowText">
                  +{overflowCount}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Local user indicator (optional) */}
        {localState && showDetailedStatus && (
          <div className="jp-UserPresence-localUser">
            <UserAvatar
              user={localState}
              size="small"
              showStatus={false}
              showTooltip={false}
              translator={translator}
            />
            <span className="jp-UserPresence-localUserLabel">
              {trans.__('You')}
            </span>
          </div>
        )}

        {/* Activity indicator for screen readers */}
        <div className="jp-sr-only" aria-live="polite" aria-atomic="false">
          {connectionStatusText}
        </div>
      </div>
    </div>
  );
};

/**
 * CSS styles for the UserPresence component
 */
const USER_PRESENCE_STYLES = `
  .jp-UserPresence {
    display: flex;
    align-items: center;
    min-height: 32px;
    padding: 4px 8px;
    font-family: var(--jp-ui-font-family);
    font-size: var(--jp-ui-font-size1);
    background: var(--jp-layout-color0);
    border-radius: var(--jp-border-radius);
  }

  .jp-UserPresence-container {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .jp-UserPresence-status {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .jp-UserPresence-status.connected {
    color: var(--jp-success-color1);
  }

  .jp-UserPresence-status.disconnected {
    color: var(--jp-error-color1);
  }

  .jp-UserPresence-statusIcon {
    font-size: 12px;
    line-height: 1;
  }

  .jp-UserPresence-statusText {
    font-size: var(--jp-ui-font-size0);
    color: var(--jp-ui-font-color2);
    white-space: nowrap;
  }

  .jp-UserPresence-users {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }

  .jp-UserPresence-avatarContainer {
    position: relative;
  }

  .jp-UserPresence-avatar {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 2px solid;
    cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    color: white;
    font-weight: 600;
    text-align: center;
    overflow: hidden;
  }

  .jp-UserPresence-avatar:hover {
    transform: scale(1.1);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }

  .jp-UserPresence-avatar:focus {
    outline: 2px solid var(--jp-brand-color1);
    outline-offset: 2px;
  }

  .jp-UserPresence-avatar-small {
    width: 24px;
    height: 24px;
    font-size: 10px;
  }

  .jp-UserPresence-avatar-medium {
    width: 32px;
    height: 32px;
    font-size: 12px;
  }

  .jp-UserPresence-avatar-large {
    width: 40px;
    height: 40px;
    font-size: 14px;
  }

  .jp-UserPresence-avatarImage {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
  }

  .jp-UserPresence-avatarInitials {
    display: block;
    line-height: 1;
  }

  .jp-UserPresence-statusIndicator {
    position: absolute;
    bottom: -2px;
    right: -2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--jp-layout-color0);
    border: 1px solid var(--jp-layout-color0);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .jp-UserPresence-statusIcon {
    font-size: 8px;
    line-height: 1;
  }

  .jp-UserPresence-tooltip {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 8px;
    z-index: 1000;
    background: var(--jp-layout-color2);
    border: 1px solid var(--jp-border-color1);
    border-radius: var(--jp-border-radius);
    padding: 8px;
    min-width: 120px;
    box-shadow: var(--jp-elevation-z6);
    font-size: var(--jp-ui-font-size0);
    color: var(--jp-ui-font-color1);
  }

  .jp-UserPresence-tooltip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: var(--jp-layout-color2);
  }

  .jp-UserPresence-tooltipContent > div {
    margin-bottom: 4px;
  }

  .jp-UserPresence-tooltipContent > div:last-child {
    margin-bottom: 0;
  }

  .jp-UserPresence-tooltipName {
    font-weight: 600;
    color: var(--jp-ui-font-color0);
  }

  .jp-UserPresence-tooltipStatus,
  .jp-UserPresence-tooltipRole,
  .jp-UserPresence-tooltipActivity,
  .jp-UserPresence-tooltipCursor {
    font-size: var(--jp-ui-font-size00);
    color: var(--jp-ui-font-color2);
  }

  .jp-UserPresence-overflow {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--jp-layout-color2);
    border: 2px solid var(--jp-border-color1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 600;
    color: var(--jp-ui-font-color1);
    cursor: pointer;
  }

  .jp-UserPresence-localUser {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--jp-layout-color1);
    border-radius: var(--jp-border-radius);
    border: 1px solid var(--jp-border-color1);
  }

  .jp-UserPresence-localUserLabel {
    font-size: var(--jp-ui-font-size0);
    color: var(--jp-ui-font-color1);
    font-weight: 500;
  }

  .jp-UserPresence-avatarError {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--jp-error-color3);
    border: 2px solid var(--jp-error-color1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
  }

  /* Screen reader only class */
  .jp-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .jp-UserPresence-statusText {
      display: none;
    }
    
    .jp-UserPresence-localUser {
      display: none;
    }
    
    .jp-UserPresence-avatar-medium {
      width: 28px;
      height: 28px;
      font-size: 11px;
    }
    
    .jp-UserPresence-tooltip {
      min-width: 100px;
      font-size: 11px;
    }
  }

  /* High contrast mode support */
  @media (prefers-contrast: high) {
    .jp-UserPresence-avatar {
      border-width: 3px;
    }
    
    .jp-UserPresence-statusIndicator {
      border-width: 2px;
    }
  }

  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    .jp-UserPresence-avatar {
      transition: none;
    }
    
    .jp-UserPresence-avatar:hover {
      transform: none;
    }
  }
`;

/**
 * Inject CSS styles into the document
 */
const injectStyles = (() => {
  let stylesInjected = false;
  
  return () => {
    if (!stylesInjected) {
      const styleElement = document.createElement('style');
      styleElement.textContent = USER_PRESENCE_STYLES;
      document.head.appendChild(styleElement);
      stylesInjected = true;
    }
  };
})();

/**
 * A namespace for UserPresenceComponent static methods.
 */
export namespace UserPresenceComponent {
  /**
   * Create a new UserPresenceComponent widget
   *
   * @param options - Creation options
   */
  export const create = ({
    awarenessService,
    tracker,
    translator,
    maxAvatars = 5,
    showDetailedStatus = false,
    className = ''
  }: {
    awarenessService: IAwarenessService;
    tracker: INotebookTracker;
    translator: ITranslator;
    maxAvatars?: number;
    showDetailedStatus?: boolean;
    className?: string;
  }): ReactWidget => {
    // Inject CSS styles
    injectStyles();

    return ReactWidget.create(
      <UserPresence
        awarenessService={awarenessService}
        tracker={tracker}
        translator={translator}
        maxAvatars={maxAvatars}
        showDetailedStatus={showDetailedStatus}
        className={className}
      />
    );
  };
}

// Export types for external use
export type { IUserAwarenessState, IAwarenessService };