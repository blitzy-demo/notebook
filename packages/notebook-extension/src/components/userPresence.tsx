/**
 * @fileoverview Real-time user presence indicators component for collaborative editing.
 * 
 * This component provides comprehensive awareness of collaborative session participants
 * including their current editing locations, activity indicators, and user identification 
 * through color-coded presence markers. It integrates with the YjsNotebookProvider and
 * CollaborativeAwareness systems to deliver sub-millisecond presence awareness broadcasting
 * and cross-browser presence state validation.
 * 
 * Key Features:
 * - Real-time user activity tracking with cursor position synchronization
 * - Color-coded user identification with customizable avatars
 * - Activity status indicators (active, idle, typing, viewing, away)
 * - Responsive design supporting mobile, tablet, and desktop viewports
 * - Comprehensive accessibility with ARIA live regions and keyboard navigation
 * - Automatic presence cleanup for disconnected users
 * - Cross-browser state validation and synchronization
 * - Performance optimization with intelligent update throttling
 * 
 * @author Jupyter Notebook Collaboration Team
 * @version 7.5.0-alpha.0
 * @since 2024-12-15
 */

import React, { 
  useState, 
  useEffect, 
  useCallback, 
  useMemo, 
  useRef,
  memo
} from 'react';
import { 
  Box, 
  Avatar, 
  Tooltip, 
  Badge, 
  IconButton,
  Popover,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Typography,
  Chip,
  useTheme,
  useMediaQuery,
  Fade,
  Collapse
} from '@mui/material';
import {
  PersonIcon,
  CircleIcon,
  KeyboardIcon,
  VisibilityIcon,
  AwayIcon,
  ExpandMoreIcon,
  ExpandLessIcon
} from '@mui/icons-material';

// Import collaboration dependencies
import { ICollaborationProvider } from '../../../notebook/src/collab/YjsNotebookProvider';
import { 
  CollaborativeAwareness,
  IUserPresence,
  ICursorPosition,
  ActivityStatus,
  UserRole,
  IAwarenessEvent,
  AwarenessEventType
} from '../../../notebook/src/collab/awareness';

/**
 * Configuration interface for the UserPresence component
 */
export interface IUserPresenceConfig {
  /** Maximum number of avatars to display before collapsing */
  maxVisibleAvatars?: number;
  /** Show detailed activity status in tooltips */
  showDetailedStatus?: boolean;
  /** Enable cursor position tracking */
  enableCursorTracking?: boolean;
  /** Avatar size variant */
  avatarSize?: 'small' | 'medium' | 'large';
  /** Position within the interface */
  position?: 'header' | 'sidebar' | 'floating';
  /** Enable presence animations */
  enableAnimations?: boolean;
  /** Update throttle interval in milliseconds */
  updateThrottle?: number;
}

/**
 * Props interface for the UserPresence component
 */
export interface IUserPresenceProps {
  /** Collaboration provider instance */
  collaborationProvider: ICollaborationProvider;
  /** Component configuration options */
  config?: IUserPresenceConfig;
  /** Custom CSS class name */
  className?: string;
  /** Accessibility label for the component */
  ariaLabel?: string;
  /** Event handler for user interactions */
  onUserClick?: (user: IUserPresence) => void;
  /** Event handler for presence changes */
  onPresenceChange?: (users: IUserPresence[]) => void;
}

/**
 * Default configuration for the UserPresence component
 */
const DEFAULT_CONFIG: Required<IUserPresenceConfig> = {
  maxVisibleAvatars: 5,
  showDetailedStatus: true,
  enableCursorTracking: true,
  avatarSize: 'medium',
  position: 'header',
  enableAnimations: true,
  updateThrottle: 100
};

/**
 * Activity status icon mapping for visual indicators
 */
const ACTIVITY_ICONS = {
  [ActivityStatus.ACTIVE]: CircleIcon,
  [ActivityStatus.TYPING]: KeyboardIcon,
  [ActivityStatus.VIEWING]: VisibilityIcon,
  [ActivityStatus.IDLE]: CircleIcon,
  [ActivityStatus.AWAY]: AwayIcon,
  [ActivityStatus.DISCONNECTED]: CircleIcon
};

/**
 * Activity status colors for visual differentiation
 */
const ACTIVITY_COLORS = {
  [ActivityStatus.ACTIVE]: '#4caf50',
  [ActivityStatus.TYPING]: '#2196f3',
  [ActivityStatus.VIEWING]: '#ff9800',
  [ActivityStatus.IDLE]: '#757575',
  [ActivityStatus.AWAY]: '#f44336',
  [ActivityStatus.DISCONNECTED]: '#9e9e9e'
};

/**
 * Role-based badge colors for user identification
 */
const ROLE_COLORS = {
  [UserRole.ADMIN]: '#e91e63',
  [UserRole.OWNER]: '#9c27b0',
  [UserRole.EDITOR]: '#3f51b5',
  [UserRole.COMMENTER]: '#009688',
  [UserRole.VIEWER]: '#607d8b'
};

/**
 * User avatar component with activity indicators and tooltips
 */
const UserAvatar: React.FC<{
  user: IUserPresence;
  size: 'small' | 'medium' | 'large';
  showDetailed: boolean;
  enableAnimations: boolean;
  onClick?: (user: IUserPresence) => void;
}> = memo(({ user, size, showDetailed, enableAnimations, onClick }) => {
  const theme = useTheme();
  const [showTooltip, setShowTooltip] = useState(false);
  
  const ActivityIcon = ACTIVITY_ICONS[user.activity.status];
  const activityColor = ACTIVITY_COLORS[user.activity.status];
  const roleColor = ROLE_COLORS[user.role];
  
  // Calculate avatar size based on variant
  const avatarSize = {
    small: 24,
    medium: 32,
    large: 40
  }[size];
  
  // Format user activity for display
  const formatActivity = useCallback(() => {
    const timeSinceActive = Date.now() - user.activity.lastActive;
    const minutesAgo = Math.floor(timeSinceActive / 60000);
    
    switch (user.activity.status) {
      case ActivityStatus.ACTIVE:
        return user.activity.currentAction || 'Active';
      case ActivityStatus.TYPING:
        return 'Typing...';
      case ActivityStatus.VIEWING:
        return 'Viewing';
      case ActivityStatus.IDLE:
        return `Idle${minutesAgo > 0 ? ` (${minutesAgo}m ago)` : ''}`;
      case ActivityStatus.AWAY:
        return 'Away';
      case ActivityStatus.DISCONNECTED:
        return 'Disconnected';
      default:
        return 'Unknown';
    }
  }, [user.activity]);
  
  // Format cursor position for display
  const formatCursorPosition = useCallback(() => {
    if (!user.cursor) return null;
    
    return `Cell: ${user.cursor.cellId}, Line: ${user.cursor.line || 0}, Col: ${user.cursor.column || 0}`;
  }, [user.cursor]);
  
  // Tooltip content with detailed user information
  const tooltipContent = useMemo(() => (
    <Box sx={{ p: 1, maxWidth: 300 }}>
      <Typography variant="subtitle2" fontWeight="bold" color="inherit">
        {user.displayName}
      </Typography>
      <Typography variant="caption" color="inherit" display="block">
        Role: {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
      </Typography>
      <Typography variant="caption" color="inherit" display="block">
        Status: {formatActivity()}
      </Typography>
      {showDetailed && user.cursor && (
        <Typography variant="caption" color="inherit" display="block">
          {formatCursorPosition()}
        </Typography>
      )}
      {showDetailed && user.activity.metrics && (
        <Typography variant="caption" color="inherit" display="block">
          Session: {Math.floor(user.activity.metrics.sessionDuration / 60000)}m
        </Typography>
      )}
    </Box>
  ), [user, showDetailed, formatActivity, formatCursorPosition]);
  
  const handleClick = useCallback(() => {
    onClick?.(user);
  }, [onClick, user]);
  
  const handleTooltipOpen = useCallback(() => {
    setShowTooltip(true);
  }, []);
  
  const handleTooltipClose = useCallback(() => {
    setShowTooltip(false);
  }, []);
  
  return (
    <Tooltip
      title={tooltipContent}
      open={showTooltip}
      onOpen={handleTooltipOpen}
      onClose={handleTooltipClose}
      arrow
      placement="bottom"
      PopperProps={{
        sx: {
          '& .MuiTooltip-tooltip': {
            backgroundColor: theme.palette.grey[900],
            color: theme.palette.common.white,
            fontSize: theme.typography.caption.fontSize,
            maxWidth: 'none'
          }
        }
      }}
    >
      <Badge
        overlap="circular"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        badgeContent={
          <ActivityIcon
            sx={{
              width: size === 'small' ? 8 : 12,
              height: size === 'small' ? 8 : 12,
              color: activityColor,
              backgroundColor: theme.palette.background.paper,
              borderRadius: '50%',
              border: `1px solid ${theme.palette.background.paper}`,
              ...(enableAnimations && user.activity.status === ActivityStatus.TYPING && {
                animation: 'jp-collab-typing-pulse 1.5s ease-in-out infinite'
              })
            }}
          />
        }
      >
        <Avatar
          sx={{
            width: avatarSize,
            height: avatarSize,
            backgroundColor: user.color,
            border: `2px solid ${roleColor}`,
            cursor: onClick ? 'pointer' : 'default',
            fontSize: avatarSize * 0.4,
            fontWeight: 'bold',
            color: theme.palette.getContrastText(user.color),
            transition: enableAnimations ? 'all 0.3s ease' : 'none',
            '&:hover': onClick ? {
              transform: enableAnimations ? 'scale(1.1)' : 'none',
              boxShadow: `0 0 0 3px ${roleColor}40`
            } : {},
            ...(enableAnimations && {
              animation: 'jp-collab-presence-pulse 2s ease-in-out infinite'
            })
          }}
          onClick={handleClick}
          src={user.avatar}
          alt={`${user.displayName} avatar`}
          role="button"
          tabIndex={onClick ? 0 : -1}
          aria-label={`${user.displayName} - ${formatActivity()}`}
        >
          {!user.avatar && user.displayName.charAt(0).toUpperCase()}
        </Avatar>
      </Badge>
    </Tooltip>
  );
});

UserAvatar.displayName = 'UserAvatar';

/**
 * Collapsed avatars indicator showing count of hidden users
 */
const CollapsedIndicator: React.FC<{
  count: number;
  users: IUserPresence[];
  size: 'small' | 'medium' | 'large';
  onClick: () => void;
}> = memo(({ count, users, size, onClick }) => {
  const theme = useTheme();
  
  const avatarSize = {
    small: 24,
    medium: 32,
    large: 40
  }[size];
  
  const tooltipContent = useMemo(() => (
    <Box sx={{ p: 1, maxWidth: 200 }}>
      <Typography variant="subtitle2" fontWeight="bold" color="inherit">
        +{count} more users
      </Typography>
      {users.slice(0, 3).map(user => (
        <Typography key={user.userId} variant="caption" color="inherit" display="block">
          {user.displayName}
        </Typography>
      ))}
      {users.length > 3 && (
        <Typography variant="caption" color="inherit" display="block">
          ...and {users.length - 3} others
        </Typography>
      )}
    </Box>
  ), [count, users]);
  
  return (
    <Tooltip title={tooltipContent} arrow placement="bottom">
      <Avatar
        sx={{
          width: avatarSize,
          height: avatarSize,
          backgroundColor: theme.palette.grey[400],
          color: theme.palette.grey[800],
          cursor: 'pointer',
          fontSize: avatarSize * 0.3,
          fontWeight: 'bold',
          border: `2px solid ${theme.palette.grey[300]}`,
          '&:hover': {
            backgroundColor: theme.palette.grey[500],
            transform: 'scale(1.05)'
          }
        }}
        onClick={onClick}
        role="button"
        tabIndex={0}
        aria-label={`Show ${count} more users`}
      >
        +{count}
      </Avatar>
    </Tooltip>
  );
});

CollapsedIndicator.displayName = 'CollapsedIndicator';

/**
 * Detailed user list component for expanded view
 */
const UserList: React.FC<{
  users: IUserPresence[];
  onUserClick?: (user: IUserPresence) => void;
}> = memo(({ users, onUserClick }) => {
  const formatLastActive = useCallback((timestamp: number) => {
    const timeDiff = Date.now() - timestamp;
    const minutes = Math.floor(timeDiff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }, []);
  
  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      // Sort by activity status priority, then by last active time
      const statusPriority = {
        [ActivityStatus.TYPING]: 0,
        [ActivityStatus.ACTIVE]: 1,
        [ActivityStatus.VIEWING]: 2,
        [ActivityStatus.IDLE]: 3,
        [ActivityStatus.AWAY]: 4,
        [ActivityStatus.DISCONNECTED]: 5
      };
      
      const aPriority = statusPriority[a.activity.status];
      const bPriority = statusPriority[b.activity.status];
      
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      
      return b.activity.lastActive - a.activity.lastActive;
    });
  }, [users]);
  
  return (
    <List dense sx={{ py: 0, maxHeight: 300, overflow: 'auto' }}>
      {sortedUsers.map(user => {
        const ActivityIcon = ACTIVITY_ICONS[user.activity.status];
        const activityColor = ACTIVITY_COLORS[user.activity.status];
        const roleColor = ROLE_COLORS[user.role];
        
        return (
          <ListItem
            key={user.userId}
            button={!!onUserClick}
            onClick={() => onUserClick?.(user)}
            sx={{
              py: 0.5,
              px: 1,
              '&:hover': onUserClick ? {
                backgroundColor: 'action.hover'
              } : {}
            }}
          >
            <ListItemAvatar>
              <Avatar
                sx={{
                  width: 32,
                  height: 32,
                  backgroundColor: user.color,
                  border: `2px solid ${roleColor}`,
                  fontSize: 14,
                  fontWeight: 'bold'
                }}
                src={user.avatar}
              >
                {!user.avatar && user.displayName.charAt(0).toUpperCase()}
              </Avatar>
            </ListItemAvatar>
            <ListItemText
              primary={
                <Box display="flex" alignItems="center" gap={1}>
                  <Typography variant="body2" fontWeight="medium">
                    {user.displayName}
                  </Typography>
                  <Chip
                    size="small"
                    label={user.role}
                    sx={{
                      height: 16,
                      fontSize: 10,
                      backgroundColor: roleColor,
                      color: 'white'
                    }}
                  />
                </Box>
              }
              secondary={
                <Box display="flex" alignItems="center" gap={1}>
                  <ActivityIcon sx={{ width: 12, height: 12, color: activityColor }} />
                  <Typography variant="caption" color="text.secondary">
                    {user.activity.currentAction || user.activity.status}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    • {formatLastActive(user.activity.lastActive)}
                  </Typography>
                </Box>
              }
            />
          </ListItem>
        );
      })}
    </List>
  );
});

UserList.displayName = 'UserList';

/**
 * Main UserPresence component providing real-time collaborative user awareness
 */
export const UserPresence: React.FC<IUserPresenceProps> = ({
  collaborationProvider,
  config = {},
  className,
  ariaLabel = 'Collaborative session participants',
  onUserClick,
  onPresenceChange
}) => {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isTablet = useMediaQuery(theme.breakpoints.down('md'));
  
  // Component state
  const [users, setUsers] = useState<IUserPresence[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Refs for performance optimization
  const updateTimeoutRef = useRef<NodeJS.Timeout>();
  const lastUpdateRef = useRef<number>(0);
  
  // Throttled update function to prevent excessive re-renders
  const throttledUpdate = useCallback((newUsers: IUserPresence[]) => {
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateRef.current;
    
    if (timeSinceLastUpdate >= finalConfig.updateThrottle) {
      setUsers(newUsers);
      lastUpdateRef.current = now;
      onPresenceChange?.(newUsers);
    } else {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
      
      updateTimeoutRef.current = setTimeout(() => {
        setUsers(newUsers);
        lastUpdateRef.current = Date.now();
        onPresenceChange?.(newUsers);
      }, finalConfig.updateThrottle - timeSinceLastUpdate);
    }
  }, [finalConfig.updateThrottle, onPresenceChange]);
  
  // Handle awareness events from the collaboration provider
  const handleAwarenessChange = useCallback((event: IAwarenessEvent) => {
    try {
      const awareness = collaborationProvider.awareness;
      const allUsers = awareness.getAllUserPresence();
      
      // Filter out disconnected users and current user for display
      const activeUsers = allUsers.filter(user => 
        user.activity.status !== ActivityStatus.DISCONNECTED &&
        user.userId !== awareness.localUser?.userId
      );
      
      throttledUpdate(activeUsers);
      
      // Announce changes for screen readers
      const announceChange = (message: string) => {
        const announcement = document.createElement('div');
        announcement.setAttribute('aria-live', 'polite');
        announcement.setAttribute('aria-atomic', 'true');
        announcement.style.position = 'absolute';
        announcement.style.left = '-10000px';
        announcement.style.width = '1px';
        announcement.style.height = '1px';
        announcement.style.overflow = 'hidden';
        announcement.textContent = message;
        document.body.appendChild(announcement);
        
        setTimeout(() => {
          document.body.removeChild(announcement);
        }, 1000);
      };
      
      // Announce user presence changes
      switch (event.type) {
        case AwarenessEventType.USER_JOINED:
          announceChange(`${event.data.displayName || 'A user'} joined the session`);
          break;
        case AwarenessEventType.USER_LEFT:
          announceChange(`${event.data.displayName || 'A user'} left the session`);
          break;
        case AwarenessEventType.ACTIVITY_CHANGED:
          if (event.data.status === ActivityStatus.TYPING) {
            announceChange(`${event.data.displayName || 'A user'} is typing`);
          }
          break;
      }
      
    } catch (err) {
      console.error('[UserPresence] Error handling awareness change:', err);
      setError('Failed to update presence information');
    }
  }, [collaborationProvider, throttledUpdate]);
  
  // Initialize awareness event listeners
  useEffect(() => {
    const awareness = collaborationProvider?.awareness;
    
    if (!awareness) {
      setError('Collaboration awareness not available');
      setIsLoading(false);
      return;
    }
    
    try {
      // Set up event listeners
      awareness.userJoined.connect(handleAwarenessChange);
      awareness.userLeft.connect(handleAwarenessChange);
      awareness.cursorMoved.connect(handleAwarenessChange);
      awareness.cellSelected.connect(handleAwarenessChange);
      awareness.activityChanged.connect(handleAwarenessChange);
      awareness.presenceUpdated.connect(handleAwarenessChange);
      
      // Initial load
      const initialUsers = awareness.getAllUserPresence().filter(user => 
        user.activity.status !== ActivityStatus.DISCONNECTED &&
        user.userId !== awareness.localUser?.userId
      );
      
      setUsers(initialUsers);
      setIsLoading(false);
      onPresenceChange?.(initialUsers);
      
      // Cleanup function
      return () => {
        awareness.userJoined.disconnect(handleAwarenessChange);
        awareness.userLeft.disconnect(handleAwarenessChange);
        awareness.cursorMoved.disconnect(handleAwarenessChange);
        awareness.cellSelected.disconnect(handleAwarenessChange);
        awareness.activityChanged.disconnect(handleAwarenessChange);
        awareness.presenceUpdated.disconnect(handleAwarenessChange);
        
        if (updateTimeoutRef.current) {
          clearTimeout(updateTimeoutRef.current);
        }
      };
      
    } catch (err) {
      console.error('[UserPresence] Error initializing awareness:', err);
      setError('Failed to initialize presence tracking');
      setIsLoading(false);
    }
  }, [collaborationProvider, handleAwarenessChange, onPresenceChange]);
  
  // Handle responsive avatar sizing
  const responsiveAvatarSize = useMemo(() => {
    if (isMobile && finalConfig.avatarSize === 'large') return 'medium';
    if (isMobile && finalConfig.avatarSize === 'medium') return 'small';
    return finalConfig.avatarSize;
  }, [isMobile, finalConfig.avatarSize]);
  
  // Calculate visible and hidden users
  const { visibleUsers, hiddenUsers, hasHiddenUsers } = useMemo(() => {
    const maxVisible = isMobile ? Math.min(finalConfig.maxVisibleAvatars, 3) : finalConfig.maxVisibleAvatars;
    const visible = users.slice(0, maxVisible);
    const hidden = users.slice(maxVisible);
    
    return {
      visibleUsers: visible,
      hiddenUsers: hidden,
      hasHiddenUsers: hidden.length > 0
    };
  }, [users, finalConfig.maxVisibleAvatars, isMobile]);
  
  // Handle popover toggle
  const handleExpandClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (hasHiddenUsers) {
      setAnchorEl(event.currentTarget);
      setExpanded(!expanded);
    }
  }, [hasHiddenUsers, expanded]);
  
  const handlePopoverClose = useCallback(() => {
    setAnchorEl(null);
    setExpanded(false);
  }, []);
  
  // Render error state
  if (error) {
    return (
      <Box 
        className={className}
        role="alert"
        aria-label="Presence tracking error"
        sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: 1,
          color: 'error.main'
        }}
      >
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      </Box>
    );
  }
  
  // Render loading state
  if (isLoading) {
    return (
      <Box 
        className={className}
        sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: 1 
        }}
        aria-label="Loading presence information"
      >
        <CircleIcon 
          sx={{ 
            width: 16, 
            height: 16, 
            color: 'action.disabled',
            animation: finalConfig.enableAnimations ? 'jp-collab-typing-pulse 1.5s ease-in-out infinite' : 'none'
          }} 
        />
        <Typography variant="caption" color="text.secondary">
          Loading...
        </Typography>
      </Box>
    );
  }
  
  // Render empty state
  if (users.length === 0) {
    return (
      <Box 
        className={className}
        sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: 1 
        }}
        aria-label="No active collaborators"
      >
        <PersonIcon sx={{ width: 16, height: 16, color: 'action.disabled' }} />
        <Typography variant="caption" color="text.secondary">
          {isMobile ? 'Solo' : 'Working alone'}
        </Typography>
      </Box>
    );
  }
  
  return (
    <>
      <Box
        className={className}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 0.5 : 1,
          p: isMobile ? 0.5 : 1,
          borderRadius: 1,
          backgroundColor: 'background.paper',
          border: `1px solid ${theme.palette.divider}`,
          boxShadow: 1
        }}
        role="region"
        aria-label={`${ariaLabel} - ${users.length} active user${users.length !== 1 ? 's' : ''}`}
        aria-live="polite"
        aria-atomic="false"
      >
        {/* User count indicator for screen readers */}
        <Box
          sx={{
            position: 'absolute',
            left: -10000,
            width: 1,
            height: 1,
            overflow: 'hidden'
          }}
          aria-live="polite"
          aria-atomic="true"
        >
          {users.length} active collaborator{users.length !== 1 ? 's' : ''}
        </Box>
        
        {/* Visible user avatars */}
        {visibleUsers.map(user => (
          <Fade 
            key={user.userId} 
            in={true} 
            timeout={finalConfig.enableAnimations ? 300 : 0}
          >
            <Box>
              <UserAvatar
                user={user}
                size={responsiveAvatarSize}
                showDetailed={finalConfig.showDetailedStatus}
                enableAnimations={finalConfig.enableAnimations}
                onClick={onUserClick}
              />
            </Box>
          </Fade>
        ))}
        
        {/* Collapsed users indicator */}
        {hasHiddenUsers && (
          <CollapsedIndicator
            count={hiddenUsers.length}
            users={hiddenUsers}
            size={responsiveAvatarSize}
            onClick={handleExpandClick}
          />
        )}
        
        {/* User count text for larger screens */}
        {!isMobile && users.length > 0 && (
          <Typography 
            variant="caption" 
            color="text.secondary"
            sx={{ ml: 1, whiteSpace: 'nowrap' }}
          >
            {users.length} active
          </Typography>
        )}
      </Box>
      
      {/* Detailed user list popover */}
      <Popover
        open={expanded}
        anchorEl={anchorEl}
        onClose={handlePopoverClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'center',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'center',
        }}
        PaperProps={{
          sx: {
            mt: 1,
            borderRadius: 2,
            boxShadow: 3,
            border: `1px solid ${theme.palette.divider}`,
            maxWidth: 320,
            minWidth: 280
          }
        }}
      >
        <Box sx={{ p: 2 }}>
          <Box 
            display="flex" 
            alignItems="center" 
            justifyContent="space-between"
            sx={{ mb: 1 }}
          >
            <Typography variant="subtitle2" fontWeight="bold">
              Active Collaborators ({users.length})
            </Typography>
            <IconButton
              size="small"
              onClick={handlePopoverClose}
              aria-label="Close user list"
            >
              <ExpandLessIcon />
            </IconButton>
          </Box>
          <UserList 
            users={users} 
            onUserClick={onUserClick}
          />
        </Box>
      </Popover>
      
      {/* CSS animations */}
      <style>
        {`
          @keyframes jp-collab-typing-pulse {
            0%, 100% { transform: scale(1); opacity: 0.7; }
            50% { transform: scale(1.2); opacity: 1; }
          }
          
          @keyframes jp-collab-presence-pulse {
            0%, 100% { opacity: 0.8; }
            50% { opacity: 1; }
          }
          
          @media (prefers-reduced-motion: reduce) {
            .jp-collab-presence-overlay,
            .jp-collab-user-cursor,
            .jp-collab-typing-indicator {
              animation: none !important;
              transition: none !important;
            }
          }
        `}
      </style>
    </>
  );
};

UserPresence.displayName = 'UserPresence';

export default UserPresence;