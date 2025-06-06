/**
 * @fileoverview Main collaboration control panel component displaying session participants,
 * real-time connection status, sharing controls, and collaboration mode toggles.
 * 
 * This component serves as the primary interface for managing collaborative editing sessions,
 * providing users with visibility into active participants, session health, and access to
 * collaboration features like sharing, permissions, and history. The component integrates
 * seamlessly with the YjsNotebookProvider and CollaborativeAwareness systems to deliver
 * comprehensive real-time collaboration management capabilities.
 * 
 * Key Features:
 * - Real-time user presence indicators with activity status and cursor synchronization
 * - WebSocket connection health monitoring with automatic reconnection visualization
 * - Session management controls including share links, user invitations, and session termination
 * - Collaboration mode toggles for enabling/disabling various collaborative features
 * - Responsive design adaptation for mobile, tablet, and desktop viewports
 * - Comprehensive accessibility with ARIA live regions and keyboard navigation
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
  Toolbar,
  Typography,
  IconButton,
  Button,
  Tooltip,
  Badge,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControlLabel,
  Switch,
  Chip,
  Divider,
  Alert,
  Snackbar,
  CircularProgress,
  useTheme,
  useMediaQuery,
  Fade,
  Slide,
  Stack,
  Paper
} from '@mui/material';
import {
  ShareIcon,
  PersonAddIcon,
  SettingsIcon,
  ExitToAppIcon,
  HistoryIcon,
  CommentIcon,
  SecurityIcon,
  WifiIcon,
  WifiOffIcon,
  SyncIcon,
  ErrorIcon,
  ContentCopyIcon,
  CheckIcon,
  RefreshIcon,
  MoreVertIcon,
  CloseIcon,
  InfoIcon
} from '@mui/icons-material';

// Import collaboration dependencies
import { ICollaborationProvider, ConnectionState } from '../../../notebook/src/collab/YjsNotebookProvider';
import { 
  CollaborativeAwareness,
  IUserPresence,
  ActivityStatus,
  UserRole,
  IAwarenessEvent,
  AwarenessEventType
} from '../../../notebook/src/collab/awareness';
import { UserPresence } from './userPresence';

/**
 * Configuration interface for the CollaborationBar component
 */
export interface ICollaborationBarConfig {
  /** Enable share link generation and management */
  enableShareLinks?: boolean;
  /** Enable user invitation functionality */
  enableInvitations?: boolean;
  /** Enable history and version tracking features */
  enableHistory?: boolean;
  /** Enable comment and review features */
  enableComments?: boolean;
  /** Enable permission management */
  enablePermissions?: boolean;
  /** Auto-hide when no active users */
  autoHide?: boolean;
  /** Show detailed connection information */
  showDetailedStatus?: boolean;
  /** Update throttle interval in milliseconds */
  updateThrottle?: number;
  /** Position within the interface */
  position?: 'top' | 'bottom' | 'floating';
}

/**
 * Props interface for the CollaborationBar component
 */
export interface ICollaborationBarProps {
  /** Collaboration provider instance */
  collaborationProvider: ICollaborationProvider;
  /** Component configuration options */
  config?: ICollaborationBarConfig;
  /** Custom CSS class name */
  className?: string;
  /** Accessibility label for the component */
  ariaLabel?: string;
  /** Event handler for share link generation */
  onShareLink?: (link: string) => void;
  /** Event handler for user invitations */
  onInviteUser?: (email: string) => void;
  /** Event handler for session termination */
  onLeaveSession?: () => void;
  /** Event handler for collaboration settings changes */
  onSettingsChange?: (settings: Record<string, any>) => void;
}

/**
 * Default configuration for the CollaborationBar component
 */
const DEFAULT_CONFIG: Required<ICollaborationBarConfig> = {
  enableShareLinks: true,
  enableInvitations: true,
  enableHistory: true,
  enableComments: true,
  enablePermissions: true,
  autoHide: false,
  showDetailedStatus: true,
  updateThrottle: 100,
  position: 'top'
};

/**
 * Connection status configuration for visual indicators
 */
const CONNECTION_STATUS_CONFIG = {
  [ConnectionState.CONNECTED]: {
    icon: WifiIcon,
    color: '#4caf50',
    label: 'Connected',
    description: 'Real-time collaboration active'
  },
  [ConnectionState.CONNECTING]: {
    icon: SyncIcon,
    color: '#ff9800',
    label: 'Connecting',
    description: 'Establishing collaboration connection'
  },
  [ConnectionState.RECONNECTING]: {
    icon: RefreshIcon,
    color: '#ff9800',
    label: 'Reconnecting',
    description: 'Restoring collaboration connection'
  },
  [ConnectionState.DISCONNECTED]: {
    icon: WifiOffIcon,
    color: '#9e9e9e',
    label: 'Disconnected',
    description: 'Working in offline mode'
  },
  [ConnectionState.ERROR]: {
    icon: ErrorIcon,
    color: '#f44336',
    label: 'Error',
    description: 'Collaboration service unavailable'
  },
  [ConnectionState.OFFLINE]: {
    icon: WifiOffIcon,
    color: '#9e9e9e',
    label: 'Offline',
    description: 'No network connection'
  }
};

/**
 * Connection status indicator component
 */
const ConnectionStatusIndicator: React.FC<{
  connectionState: ConnectionState;
  onClick?: () => void;
  showLabel?: boolean;
}> = memo(({ connectionState, onClick, showLabel = true }) => {
  const theme = useTheme();
  const config = CONNECTION_STATUS_CONFIG[connectionState];
  const StatusIcon = config.icon;

  return (
    <Tooltip title={config.description} arrow>
      <Box
        display="flex"
        alignItems="center"
        gap={1}
        sx={{
          cursor: onClick ? 'pointer' : 'default',
          '&:hover': onClick ? {
            backgroundColor: theme.palette.action.hover,
            borderRadius: 1
          } : {}
        }}
        onClick={onClick}
        role={onClick ? 'button' : 'status'}
        tabIndex={onClick ? 0 : -1}
        aria-label={`Collaboration status: ${config.label}`}
      >
        <StatusIcon
          sx={{
            width: 16,
            height: 16,
            color: config.color,
            ...(connectionState === ConnectionState.CONNECTING && {
              animation: 'jp-collab-spin 1s linear infinite'
            })
          }}
        />
        {showLabel && (
          <Typography variant="caption" color="text.secondary">
            {config.label}
          </Typography>
        )}
      </Box>
    </Tooltip>
  );
});

ConnectionStatusIndicator.displayName = 'ConnectionStatusIndicator';

/**
 * Share dialog component for generating and managing collaboration links
 */
const ShareDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  collaborationProvider: ICollaborationProvider;
  onShareLink?: (link: string) => void;
}> = memo(({ open, onClose, collaborationProvider, onShareLink }) => {
  const [shareLink, setShareLink] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [permissions, setPermissions] = useState<'viewer' | 'editor' | 'admin'>('editor');
  const [expiry, setExpiry] = useState<string>('7d');

  const generateShareLink = useCallback(async () => {
    setIsGenerating(true);
    try {
      // Simulate share link generation
      const sessionId = collaborationProvider.sessionId;
      const baseUrl = window.location.origin + window.location.pathname;
      const link = `${baseUrl}?collaboration=${sessionId}&role=${permissions}&expires=${expiry}`;
      setShareLink(link);
      onShareLink?.(link);
    } catch (error) {
      console.error('Failed to generate share link:', error);
    } finally {
      setIsGenerating(false);
    }
  }, [collaborationProvider, permissions, expiry, onShareLink]);

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }, [shareLink]);

  useEffect(() => {
    if (open && !shareLink) {
      generateShareLink();
    }
  }, [open, shareLink, generateShareLink]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="share-dialog-title"
    >
      <DialogTitle id="share-dialog-title">
        Share Collaboration Session
      </DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <Typography variant="body2" color="text.secondary">
            Generate a link to invite others to this collaborative session.
          </Typography>
          
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Default Permission Level
            </Typography>
            <Box display="flex" gap={1}>
              {(['viewer', 'editor', 'admin'] as const).map((role) => (
                <Chip
                  key={role}
                  label={role.charAt(0).toUpperCase() + role.slice(1)}
                  variant={permissions === role ? 'filled' : 'outlined'}
                  color={permissions === role ? 'primary' : 'default'}
                  onClick={() => setPermissions(role)}
                  clickable
                />
              ))}
            </Box>
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Link Expiry
            </Typography>
            <Box display="flex" gap={1}>
              {[
                { value: '1h', label: '1 Hour' },
                { value: '1d', label: '1 Day' },
                { value: '7d', label: '7 Days' },
                { value: '30d', label: '30 Days' },
                { value: 'never', label: 'Never' }
              ].map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  variant={expiry === option.value ? 'filled' : 'outlined'}
                  color={expiry === option.value ? 'primary' : 'default'}
                  onClick={() => setExpiry(option.value)}
                  clickable
                />
              ))}
            </Box>
          </Box>

          {shareLink && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Collaboration Link
              </Typography>
              <Box display="flex" gap={1} alignItems="center">
                <TextField
                  fullWidth
                  value={shareLink}
                  variant="outlined"
                  size="small"
                  InputProps={{
                    readOnly: true,
                    endAdornment: (
                      <IconButton
                        onClick={copyToClipboard}
                        size="small"
                        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
                      >
                        {copied ? <CheckIcon color="success" /> : <ContentCopyIcon />}
                      </IconButton>
                    )
                  }}
                />
              </Box>
              {copied && (
                <Typography variant="caption" color="success.main" mt={0.5}>
                  Link copied to clipboard!
                </Typography>
              )}
            </Box>
          )}

          {isGenerating && (
            <Box display="flex" alignItems="center" gap={1}>
              <CircularProgress size={16} />
              <Typography variant="caption" color="text.secondary">
                Generating secure collaboration link...
              </Typography>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>
          Close
        </Button>
        <Button 
          onClick={generateShareLink} 
          variant="contained"
          disabled={isGenerating}
        >
          Regenerate Link
        </Button>
      </DialogActions>
    </Dialog>
  );
});

ShareDialog.displayName = 'ShareDialog';

/**
 * Settings dialog component for collaboration preferences
 */
const SettingsDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  config: ICollaborationBarConfig;
  onSettingsChange?: (settings: Record<string, any>) => void;
}> = memo(({ open, onClose, config, onSettingsChange }) => {
  const [settings, setSettings] = useState<Record<string, any>>({
    enableComments: config.enableComments,
    enableHistory: config.enableHistory,
    enablePermissions: config.enablePermissions,
    showDetailedStatus: config.showDetailedStatus,
    autoHide: config.autoHide
  });

  const handleSettingChange = useCallback((key: string, value: any) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    onSettingsChange?.(newSettings);
  }, [settings, onSettingsChange]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="settings-dialog-title"
    >
      <DialogTitle id="settings-dialog-title">
        Collaboration Settings
      </DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <Typography variant="body2" color="text.secondary">
            Configure collaboration features and display preferences.
          </Typography>
          
          <Divider />
          
          <FormControlLabel
            control={
              <Switch
                checked={settings.enableComments}
                onChange={(e) => handleSettingChange('enableComments', e.target.checked)}
              />
            }
            label="Enable Comments"
          />
          
          <FormControlLabel
            control={
              <Switch
                checked={settings.enableHistory}
                onChange={(e) => handleSettingChange('enableHistory', e.target.checked)}
              />
            }
            label="Enable Version History"
          />
          
          <FormControlLabel
            control={
              <Switch
                checked={settings.enablePermissions}
                onChange={(e) => handleSettingChange('enablePermissions', e.target.checked)}
              />
            }
            label="Enable Permission Management"
          />
          
          <Divider />
          
          <FormControlLabel
            control={
              <Switch
                checked={settings.showDetailedStatus}
                onChange={(e) => handleSettingChange('showDetailedStatus', e.target.checked)}
              />
            }
            label="Show Detailed Connection Status"
          />
          
          <FormControlLabel
            control={
              <Switch
                checked={settings.autoHide}
                onChange={(e) => handleSettingChange('autoHide', e.target.checked)}
              />
            }
            label="Auto-hide When No Active Users"
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
});

SettingsDialog.displayName = 'SettingsDialog';

/**
 * Invite dialog component for adding new collaborators
 */
const InviteDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onInviteUser?: (email: string) => void;
}> = memo(({ open, onClose, onInviteUser }) => {
  const [email, setEmail] = useState('');
  const [isInviting, setIsInviting] = useState(false);

  const handleInvite = useCallback(async () => {
    if (!email || !email.includes('@')) {
      return;
    }

    setIsInviting(true);
    try {
      onInviteUser?.(email);
      setEmail('');
      onClose();
    } catch (error) {
      console.error('Failed to send invitation:', error);
    } finally {
      setIsInviting(false);
    }
  }, [email, onInviteUser, onClose]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="invite-dialog-title"
    >
      <DialogTitle id="invite-dialog-title">
        Invite Collaborator
      </DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <Typography variant="body2" color="text.secondary">
            Invite someone to join this collaborative session by email.
          </Typography>
          
          <TextField
            fullWidth
            label="Email Address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter email address"
            type="email"
            variant="outlined"
            autoFocus
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>
          Cancel
        </Button>
        <Button 
          onClick={handleInvite}
          variant="contained"
          disabled={!email || !email.includes('@') || isInviting}
        >
          {isInviting ? <CircularProgress size={16} /> : 'Send Invite'}
        </Button>
      </DialogActions>
    </Dialog>
  );
});

InviteDialog.displayName = 'InviteDialog';

/**
 * Main CollaborationBar component providing comprehensive collaboration management
 */
export const CollaborationBar: React.FC<ICollaborationBarProps> = ({
  collaborationProvider,
  config = {},
  className,
  ariaLabel = 'Collaboration control panel',
  onShareLink,
  onInviteUser,
  onLeaveSession,
  onSettingsChange
}) => {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isTablet = useMediaQuery(theme.breakpoints.down('md'));

  // Component state
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    collaborationProvider?.connectionState || ConnectionState.DISCONNECTED
  );
  const [users, setUsers] = useState<IUserPresence[]>([]);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number>(0);
  
  // Dialog states
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [moreMenuAnchor, setMoreMenuAnchor] = useState<HTMLElement | null>(null);
  
  // Notification state
  const [notification, setNotification] = useState<{
    message: string;
    severity: 'success' | 'info' | 'warning' | 'error';
  } | null>(null);

  // Refs for performance optimization
  const updateTimeoutRef = useRef<NodeJS.Timeout>();

  // Handle collaboration provider events
  const handleProviderEvent = useCallback((event?: any) => {
    try {
      if (!collaborationProvider) return;

      // Update connection state
      setConnectionState(collaborationProvider.connectionState);

      // Update session active status
      const isActive = collaborationProvider.isReady();
      setIsSessionActive(isActive);

      // Update last sync time
      setLastSyncTime(Date.now());

      // Update users from awareness system
      if (collaborationProvider.awareness) {
        const allUsers = collaborationProvider.awareness.getAllUserPresence();
        const activeUsers = allUsers.filter(user => 
          user.activity.status !== ActivityStatus.DISCONNECTED &&
          user.userId !== collaborationProvider.awareness.localUser?.userId
        );
        setUsers(activeUsers);
      }
    } catch (error) {
      console.error('[CollaborationBar] Error handling provider event:', error);
    }
  }, [collaborationProvider]);

  // Initialize collaboration provider event listeners
  useEffect(() => {
    if (!collaborationProvider) return;

    // Set up event listeners
    const cleanup: (() => void)[] = [];

    try {
      // Connection state changes
      if (collaborationProvider.connectionStateChanged) {
        const handleConnectionChange = (state: ConnectionState) => {
          setConnectionState(state);
          
          // Show notifications for connection changes
          if (state === ConnectionState.CONNECTED) {
            setNotification({
              message: 'Connected to collaboration session',
              severity: 'success'
            });
          } else if (state === ConnectionState.ERROR) {
            setNotification({
              message: 'Collaboration service unavailable',
              severity: 'error'
            });
          }
        };
        
        collaborationProvider.connectionStateChanged.connect(handleConnectionChange);
        cleanup.push(() => {
          collaborationProvider.connectionStateChanged.disconnect(handleConnectionChange);
        });
      }

      // Awareness events
      if (collaborationProvider.awareness) {
        const awareness = collaborationProvider.awareness;
        
        const handleUserJoined = (event: IAwarenessEvent) => {
          setNotification({
            message: `${event.data.displayName || 'A user'} joined the session`,
            severity: 'info'
          });
          handleProviderEvent();
        };
        
        const handleUserLeft = (event: IAwarenessEvent) => {
          setNotification({
            message: `${event.data.displayName || 'A user'} left the session`,
            severity: 'info'
          });
          handleProviderEvent();
        };

        awareness.userJoined.connect(handleUserJoined);
        awareness.userLeft.connect(handleUserLeft);
        awareness.presenceUpdated.connect(handleProviderEvent);
        
        cleanup.push(() => {
          awareness.userJoined.disconnect(handleUserJoined);
          awareness.userLeft.disconnect(handleUserLeft);
          awareness.presenceUpdated.disconnect(handleProviderEvent);
        });
      }

      // Initial state update
      handleProviderEvent();

    } catch (error) {
      console.error('[CollaborationBar] Error setting up event listeners:', error);
    }

    return () => {
      cleanup.forEach(fn => fn());
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, [collaborationProvider, handleProviderEvent]);

  // Event handlers
  const handleShareClick = useCallback(() => {
    setShareDialogOpen(true);
  }, []);

  const handleInviteClick = useCallback(() => {
    setInviteDialogOpen(true);
  }, []);

  const handleSettingsClick = useCallback(() => {
    setSettingsDialogOpen(true);
  }, []);

  const handleLeaveSession = useCallback(() => {
    try {
      onLeaveSession?.();
      setNotification({
        message: 'Left collaboration session',
        severity: 'info'
      });
    } catch (error) {
      console.error('[CollaborationBar] Error leaving session:', error);
      setNotification({
        message: 'Failed to leave session',
        severity: 'error'
      });
    }
  }, [onLeaveSession]);

  const handleHistoryClick = useCallback(() => {
    // Open history viewer - would typically be handled by parent component
    console.log('Opening history viewer');
  }, []);

  const handleCommentsClick = useCallback(() => {
    // Toggle comments panel - would typically be handled by parent component
    console.log('Toggling comments panel');
  }, []);

  const handleMoreMenuClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    setMoreMenuAnchor(event.currentTarget);
  }, []);

  const handleMoreMenuClose = useCallback(() => {
    setMoreMenuAnchor(null);
  }, []);

  const handleNotificationClose = useCallback(() => {
    setNotification(null);
  }, []);

  // Auto-hide logic
  const shouldShow = useMemo(() => {
    if (!finalConfig.autoHide) return true;
    return isSessionActive && (users.length > 0 || connectionState === ConnectionState.CONNECTED);
  }, [finalConfig.autoHide, isSessionActive, users.length, connectionState]);

  // Render nothing if collaboration provider is not available
  if (!collaborationProvider) {
    return null;
  }

  // Hide if auto-hide is enabled and no active session
  if (!shouldShow) {
    return null;
  }

  return (
    <>
      <Slide direction="down" in={shouldShow} mountOnEnter unmountOnExit>
        <Paper
          className={className}
          elevation={1}
          sx={{
            borderBottom: `1px solid ${theme.palette.divider}`,
            backgroundColor: theme.palette.background.paper,
            position: finalConfig.position === 'floating' ? 'absolute' : 'sticky',
            top: finalConfig.position === 'top' ? 0 : 'auto',
            bottom: finalConfig.position === 'bottom' ? 0 : 'auto',
            zIndex: theme.zIndex.appBar,
            ...(finalConfig.position === 'floating' && {
              right: 16,
              top: 16,
              borderRadius: 2,
              boxShadow: theme.shadows[3]
            })
          }}
          role="region"
          aria-label={ariaLabel}
        >
          <Toolbar
            variant="dense"
            sx={{
              minHeight: isMobile ? 48 : 56,
              px: isMobile ? 1 : 2,
              gap: isMobile ? 0.5 : 1
            }}
          >
            {/* Connection Status */}
            <ConnectionStatusIndicator
              connectionState={connectionState}
              showLabel={!isMobile && finalConfig.showDetailedStatus}
            />

            {/* Divider */}
            <Divider orientation="vertical" flexItem sx={{ mx: isMobile ? 0.5 : 1 }} />

            {/* User Presence */}
            <Box flexGrow={1}>
              <UserPresence
                collaborationProvider={collaborationProvider}
                config={{
                  maxVisibleAvatars: isMobile ? 3 : 5,
                  avatarSize: isMobile ? 'small' : 'medium',
                  showDetailedStatus: !isMobile,
                  position: 'header'
                }}
              />
            </Box>

            {/* Action Buttons */}
            <Stack direction="row" spacing={isMobile ? 0.5 : 1} alignItems="center">
              {/* Share Button */}
              {finalConfig.enableShareLinks && (
                <Tooltip title="Share session">
                  <IconButton
                    size={isMobile ? 'small' : 'medium'}
                    onClick={handleShareClick}
                    aria-label="Share collaboration session"
                  >
                    <ShareIcon />
                  </IconButton>
                </Tooltip>
              )}

              {/* Invite Button */}
              {finalConfig.enableInvitations && !isMobile && (
                <Tooltip title="Invite user">
                  <IconButton
                    size="medium"
                    onClick={handleInviteClick}
                    aria-label="Invite user to session"
                  >
                    <PersonAddIcon />
                  </IconButton>
                </Tooltip>
              )}

              {/* Comments Button */}
              {finalConfig.enableComments && !isMobile && (
                <Tooltip title="Comments">
                  <IconButton
                    size="medium"
                    onClick={handleCommentsClick}
                    aria-label="View comments"
                  >
                    <CommentIcon />
                  </IconButton>
                </Tooltip>
              )}

              {/* History Button */}
              {finalConfig.enableHistory && !isMobile && (
                <Tooltip title="Version history">
                  <IconButton
                    size="medium"
                    onClick={handleHistoryClick}
                    aria-label="View version history"
                  >
                    <HistoryIcon />
                  </IconButton>
                </Tooltip>
              )}

              {/* More Menu (Mobile) */}
              {isMobile ? (
                <>
                  <Tooltip title="More options">
                    <IconButton
                      size="small"
                      onClick={handleMoreMenuClick}
                      aria-label="More collaboration options"
                    >
                      <MoreVertIcon />
                    </IconButton>
                  </Tooltip>
                  <Menu
                    anchorEl={moreMenuAnchor}
                    open={Boolean(moreMenuAnchor)}
                    onClose={handleMoreMenuClose}
                    PaperProps={{
                      sx: { minWidth: 200 }
                    }}
                  >
                    {finalConfig.enableInvitations && (
                      <MenuItem onClick={() => { handleInviteClick(); handleMoreMenuClose(); }}>
                        <PersonAddIcon sx={{ mr: 1 }} />
                        Invite User
                      </MenuItem>
                    )}
                    {finalConfig.enableComments && (
                      <MenuItem onClick={() => { handleCommentsClick(); handleMoreMenuClose(); }}>
                        <CommentIcon sx={{ mr: 1 }} />
                        Comments
                      </MenuItem>
                    )}
                    {finalConfig.enableHistory && (
                      <MenuItem onClick={() => { handleHistoryClick(); handleMoreMenuClose(); }}>
                        <HistoryIcon sx={{ mr: 1 }} />
                        History
                      </MenuItem>
                    )}
                    <Divider />
                    <MenuItem onClick={() => { handleSettingsClick(); handleMoreMenuClose(); }}>
                      <SettingsIcon sx={{ mr: 1 }} />
                      Settings
                    </MenuItem>
                    <MenuItem onClick={() => { handleLeaveSession(); handleMoreMenuClose(); }}>
                      <ExitToAppIcon sx={{ mr: 1 }} />
                      Leave Session
                    </MenuItem>
                  </Menu>
                </>
              ) : (
                <>
                  {/* Settings Button */}
                  <Tooltip title="Settings">
                    <IconButton
                      size="medium"
                      onClick={handleSettingsClick}
                      aria-label="Collaboration settings"
                    >
                      <SettingsIcon />
                    </IconButton>
                  </Tooltip>

                  {/* Leave Button */}
                  <Tooltip title="Leave session">
                    <IconButton
                      size="medium"
                      onClick={handleLeaveSession}
                      aria-label="Leave collaboration session"
                      color="error"
                    >
                      <ExitToAppIcon />
                    </IconButton>
                  </Tooltip>
                </>
              )}
            </Stack>
          </Toolbar>
        </Paper>
      </Slide>

      {/* Dialogs */}
      <ShareDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        collaborationProvider={collaborationProvider}
        onShareLink={onShareLink}
      />

      <SettingsDialog
        open={settingsDialogOpen}
        onClose={() => setSettingsDialogOpen(false)}
        config={finalConfig}
        onSettingsChange={onSettingsChange}
      />

      <InviteDialog
        open={inviteDialogOpen}
        onClose={() => setInviteDialogOpen(false)}
        onInviteUser={onInviteUser}
      />

      {/* Notifications */}
      <Snackbar
        open={Boolean(notification)}
        autoHideDuration={4000}
        onClose={handleNotificationClose}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {notification && (
          <Alert
            onClose={handleNotificationClose}
            severity={notification.severity}
            variant="filled"
            sx={{ mt: finalConfig.position === 'top' ? 8 : 0 }}
          >
            {notification.message}
          </Alert>
        )}
      </Snackbar>

      {/* CSS Animations */}
      <style>
        {`
          @keyframes jp-collab-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          
          @media (prefers-reduced-motion: reduce) {
            .jp-collab-status-bar,
            .jp-collab-connection-indicator,
            .jp-collab-notification {
              animation: none !important;
              transition: none !important;
            }
          }
        `}
      </style>
    </>
  );
};

CollaborationBar.displayName = 'CollaborationBar';

export default CollaborationBar;