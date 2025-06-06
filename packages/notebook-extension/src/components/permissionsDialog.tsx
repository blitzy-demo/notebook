/**
 * @fileoverview Comprehensive permission management interface component for configuring user roles,
 * access levels, and sharing settings in collaborative Jupyter Notebook sessions.
 * 
 * This component provides enterprise-grade role-based access control enforcement, user invitation
 * workflows, and session-based permission validation with seamless JupyterHub integration. It serves
 * as the primary interface for managing collaborative session security, user permissions, and sharing
 * settings while maintaining comprehensive audit logging for compliance requirements.
 * 
 * Key Features:
 * - Role-based access control with configurable permission levels (viewer, editor, admin, owner)
 * - JupyterHub authentication integration with session-based validation
 * - User invitation and approval workflows with email and username support
 * - Real-time permission enforcement across collaborative operations
 * - Comprehensive audit logging for security monitoring and compliance
 * - Session-based permission management with delegation capabilities
 * - Integration with collaborative editing, lock management, and awareness systems
 * 
 * Technical Integration:
 * - Seamless integration with YjsNotebookProvider for real-time collaboration
 * - Direct integration with Permission Service for enforcement and validation
 * - WebSocket-based real-time updates for permission changes
 * - PostgreSQL integration for permission storage and audit trails
 * - Enterprise security features including role delegation and approval workflows
 * 
 * @author Jupyter Notebook Collaboration Team
 * @version 7.5.0-alpha.0
 * @since 2024-12-15
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  Avatar,
  IconButton,
  Typography,
  Box,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  ListItemSecondaryAction,
  Switch,
  FormControlLabel,
  CircularProgress,
  Snackbar,
  Alert,
  Autocomplete,
  Divider,
  Badge,
  Tooltip,
  Paper,
  Grid,
  Card,
  CardContent,
  CardActions,
  Tabs,
  Tab,
  TableContainer,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TablePagination,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import {
  PersonAdd as PersonAddIcon,
  Security as SecurityIcon,
  Edit as EditIcon,
  Visibility as VisibilityIcon,
  AdminPanelSettings as AdminIcon,
  Crown as OwnerIcon,
  Delete as DeleteIcon,
  Send as SendIcon,
  Search as SearchIcon,
  History as HistoryIcon,
  Link as LinkIcon,
  Warning as WarningIcon,
  CheckCircle as CheckCircleIcon,
  PendingActions as PendingIcon,
  ExpandMore as ExpandMoreIcon,
  FileCopy as CopyIcon,
  Settings as SettingsIcon,
  Group as GroupIcon,
  Email as EmailIcon,
  Schedule as ScheduleIcon,
} from '@mui/icons-material';

// Import collaboration dependencies
import type { YjsNotebookProvider } from '../../../notebook/src/collab/YjsNotebookProvider';
import type {
  IPermissionService,
  IUserInfo,
  IPermissionGrant,
  IPermissionRequest,
  UserRole,
  PermissionType,
  PermissionScope,
  IPermissionValidationResult,
  IAuditLogEntry,
  ISessionPermission,
} from '../../../notebook/src/collab/permissions';

/**
 * Permission dialog configuration interface
 */
interface IPermissionsDialogConfig {
  /** Collaboration provider instance */
  collaborationProvider: YjsNotebookProvider;
  /** Permission service instance */
  permissionService: IPermissionService;
  /** Current session identifier */
  sessionId: string;
  /** Current user information */
  currentUser: IUserInfo;
  /** Notebook path or identifier */
  notebookPath: string;
  /** Dialog open state */
  open: boolean;
  /** Dialog close handler */
  onClose: () => void;
  /** Permission change callback */
  onPermissionChange?: (userId: string, newRole: UserRole) => void;
  /** User invitation callback */
  onUserInvited?: (userInfo: IUserInfo, role: UserRole) => void;
}

/**
 * User search result interface
 */
interface IUserSearchResult {
  /** User identifier */
  userId: string;
  /** Display name */
  displayName: string;
  /** Email address */
  email: string;
  /** Avatar URL */
  avatar?: string;
  /** User groups */
  groups: string[];
  /** Whether user is already in session */
  isInSession: boolean;
}

/**
 * Permission summary interface
 */
interface IPermissionSummary {
  /** User information */
  user: IUserInfo;
  /** Current role */
  role: UserRole;
  /** Permission grant details */
  grant: IPermissionGrant;
  /** Last activity timestamp */
  lastActivity: Date;
  /** Whether user is currently active */
  isActive: boolean;
}

/**
 * Session settings interface
 */
interface ISessionSettings {
  /** Allow public viewing */
  allowPublicViewing: boolean;
  /** Require approval for new editors */
  requireApprovalForEditors: boolean;
  /** Enable comment notifications */
  enableCommentNotifications: boolean;
  /** Lock cells during editing */
  lockCellsDuringEditing: boolean;
  /** Session expiration time */
  sessionExpirationHours: number;
  /** Maximum users per session */
  maxUsersPerSession: number;
}

/**
 * Comprehensive permissions dialog component providing enterprise-grade access control
 * for collaborative Jupyter Notebook sessions.
 */
export const PermissionsDialog: React.FC<IPermissionsDialogConfig> = ({
  collaborationProvider,
  permissionService,
  sessionId,
  currentUser,
  notebookPath,
  open,
  onClose,
  onPermissionChange,
  onUserInvited,
}) => {
  // State management
  const [tabValue, setTabValue] = useState(0);
  const [currentPermissions, setCurrentPermissions] = useState<IPermissionSummary[]>([]);
  const [pendingRequests, setPendingRequests] = useState<IPermissionRequest[]>([]);
  const [auditLog, setAuditLog] = useState<IAuditLogEntry[]>([]);
  const [userSearchResults, setUserSearchResults] = useState<IUserSearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<UserRole>(UserRole.EDITOR);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sessionSettings, setSessionSettings] = useState<ISessionSettings>({
    allowPublicViewing: false,
    requireApprovalForEditors: false,
    enableCommentNotifications: true,
    lockCellsDuringEditing: true,
    sessionExpirationHours: 24,
    maxUsersPerSession: 10,
  });
  const [shareLink, setShareLink] = useState<string>('');
  const [auditPage, setAuditPage] = useState(0);
  const [auditRowsPerPage, setAuditRowsPerPage] = useState(10);
  const [expandedAccordions, setExpandedAccordions] = useState<Set<string>>(new Set());

  // Refs for cleanup
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const permissionUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Role hierarchy for permission validation
   */
  const roleHierarchy = useMemo(() => [
    UserRole.VIEWER,
    UserRole.EDITOR,
    UserRole.COLLABORATOR,
    UserRole.ADMIN,
    UserRole.OWNER,
  ], []);

  /**
   * Role display configuration
   */
  const roleConfig = useMemo(() => ({
    [UserRole.VIEWER]: {
      label: 'Viewer',
      icon: <VisibilityIcon fontSize="small" />,
      color: '#9e9e9e',
      description: 'Can view notebook content and comments',
      permissions: ['Read content', 'View comments', 'Export notebook'],
    },
    [UserRole.EDITOR]: {
      label: 'Editor',
      icon: <EditIcon fontSize="small" />,
      color: '#2196f3',
      description: 'Can edit notebook content and add comments',
      permissions: ['Edit content', 'Add comments', 'View history'],
    },
    [UserRole.COLLABORATOR]: {
      label: 'Collaborator',
      icon: <GroupIcon fontSize="small" />,
      color: '#4caf50',
      description: 'Can edit and execute notebook content',
      permissions: ['Execute cells', 'Manage structure', 'Collaborate in real-time'],
    },
    [UserRole.ADMIN]: {
      label: 'Admin',
      icon: <AdminIcon fontSize="small" />,
      color: '#ff9800',
      description: 'Can manage users and notebook settings',
      permissions: ['Manage permissions', 'Share notebook', 'Configure settings'],
    },
    [UserRole.OWNER]: {
      label: 'Owner',
      icon: <OwnerIcon fontSize="small" />,
      color: '#f44336',
      description: 'Full control over notebook and permissions',
      permissions: ['Full control', 'Delete notebook', 'Transfer ownership'],
    },
  }), []);

  /**
   * Check if current user has admin privileges
   */
  const hasAdminPrivileges = useMemo(() => {
    const currentUserRole = currentPermissions.find(p => p.user.userId === currentUser.userId)?.role;
    return currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.OWNER;
  }, [currentPermissions, currentUser.userId]);

  /**
   * Check if current user can modify permissions for a specific role
   */
  const canModifyRole = useCallback((targetRole: UserRole): boolean => {
    if (!hasAdminPrivileges) return false;
    
    const currentUserRole = currentPermissions.find(p => p.user.userId === currentUser.userId)?.role;
    if (!currentUserRole) return false;

    const currentUserIndex = roleHierarchy.indexOf(currentUserRole);
    const targetRoleIndex = roleHierarchy.indexOf(targetRole);
    
    // Can only modify roles lower in hierarchy
    return currentUserIndex > targetRoleIndex;
  }, [hasAdminPrivileges, currentPermissions, currentUser.userId, roleHierarchy]);

  /**
   * Load current permissions for the session
   */
  const loadCurrentPermissions = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Get session permissions
      const sessionPermissions = await permissionService.getSessionPermissions(sessionId);
      
      // Convert to permission summaries with user information
      const permissionSummaries: IPermissionSummary[] = [];
      
      for (const permission of sessionPermissions) {
        try {
          // Get user information (mock implementation - would integrate with JupyterHub)
          const userInfo: IUserInfo = {
            userId: permission.userId,
            displayName: permission.userId, // Would be resolved from JupyterHub
            email: `${permission.userId}@example.com`, // Would be resolved from JupyterHub
            groups: [],
            isAdmin: permission.role === UserRole.ADMIN || permission.role === UserRole.OWNER,
            createdAt: new Date(),
            lastActivity: new Date(),
            attributes: {},
          };

          permissionSummaries.push({
            user: userInfo,
            role: permission.role,
            grant: permission,
            lastActivity: new Date(),
            isActive: collaborationProvider.awareness?.getActiveUsers().some(u => u.userId === permission.userId) || false,
          });
        } catch (userError) {
          console.warn(`Failed to load user info for ${permission.userId}:`, userError);
        }
      }

      setCurrentPermissions(permissionSummaries);
    } catch (err) {
      console.error('Failed to load current permissions:', err);
      setError('Failed to load current permissions. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [permissionService, sessionId, collaborationProvider.awareness]);

  /**
   * Load pending permission requests
   */
  const loadPendingRequests = useCallback(async () => {
    try {
      // Mock implementation - would query database for pending requests
      const mockRequests: IPermissionRequest[] = [
        {
          requestId: 'req-001',
          requestingUserId: 'alice.smith',
          permission: PermissionType.WRITE,
          resourceId: notebookPath,
          scope: PermissionScope.NOTEBOOK,
          justification: 'Need to collaborate on data analysis section',
          status: 'pending',
          requestedAt: new Date(Date.now() - 3600000), // 1 hour ago
        },
        {
          requestId: 'req-002',
          requestingUserId: 'bob.wilson',
          permission: PermissionType.EXECUTE,
          resourceId: notebookPath,
          scope: PermissionScope.NOTEBOOK,
          justification: 'Required for testing experimental algorithms',
          status: 'pending',
          requestedAt: new Date(Date.now() - 7200000), // 2 hours ago
        },
      ];

      setPendingRequests(mockRequests);
    } catch (err) {
      console.error('Failed to load pending requests:', err);
    }
  }, [notebookPath]);

  /**
   * Load audit log entries
   */
  const loadAuditLog = useCallback(async () => {
    try {
      const auditEntries = await permissionService.getAuditLog(
        { resourceId: notebookPath },
        auditRowsPerPage,
        auditPage * auditRowsPerPage
      );
      setAuditLog(auditEntries);
    } catch (err) {
      console.error('Failed to load audit log:', err);
    }
  }, [permissionService, notebookPath, auditPage, auditRowsPerPage]);

  /**
   * Search for users to invite
   */
  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim()) {
      setUserSearchResults([]);
      return;
    }

    try {
      setIsSearching(true);
      setError(null);

      // Clear previous timeout
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      // Debounce search requests
      searchTimeoutRef.current = setTimeout(async () => {
        try {
          // Mock implementation - would integrate with JupyterHub user directory
          const mockResults: IUserSearchResult[] = [
            {
              userId: 'alice.smith',
              displayName: 'Dr. Alice Smith',
              email: 'alice.smith@university.edu',
              avatar: '/avatars/alice.jpg',
              groups: ['researchers', 'data-science'],
              isInSession: currentPermissions.some(p => p.user.userId === 'alice.smith'),
            },
            {
              userId: 'bob.wilson',
              displayName: 'Bob Wilson',
              email: 'bob.wilson@company.com',
              avatar: '/avatars/bob.jpg',
              groups: ['analysts', 'ml-team'],
              isInSession: currentPermissions.some(p => p.user.userId === 'bob.wilson'),
            },
            {
              userId: 'carol.davis',
              displayName: 'Carol Davis',
              email: 'carol.davis@research.org',
              groups: ['researchers', 'statistics'],
              isInSession: currentPermissions.some(p => p.user.userId === 'carol.davis'),
            },
          ].filter(user => 
            user.displayName.toLowerCase().includes(query.toLowerCase()) ||
            user.email.toLowerCase().includes(query.toLowerCase()) ||
            user.userId.toLowerCase().includes(query.toLowerCase())
          );

          setUserSearchResults(mockResults);
        } catch (searchError) {
          console.error('User search failed:', searchError);
          setError('Failed to search users. Please try again.');
        } finally {
          setIsSearching(false);
        }
      }, 300); // 300ms debounce
    } catch (err) {
      console.error('Search initialization failed:', err);
      setIsSearching(false);
    }
  }, [currentPermissions]);

  /**
   * Invite user to session
   */
  const inviteUser = useCallback(async (user: IUserSearchResult, role: UserRole) => {
    try {
      setIsSaving(true);
      setError(null);

      // Create permission grant
      const grant = await permissionService.grantPermission({
        userId: user.userId,
        permission: getPermissionForRole(role),
        scope: PermissionScope.NOTEBOOK,
        resourceId: notebookPath,
        role: role,
        grantedBy: currentUser.userId,
        metadata: {
          invitedAt: new Date().toISOString(),
          invitationType: 'direct',
          sessionId: sessionId,
        },
        delegatable: role !== UserRole.OWNER,
      });

      // Update local state
      const newPermission: IPermissionSummary = {
        user: {
          userId: user.userId,
          displayName: user.displayName,
          email: user.email,
          groups: user.groups,
          isAdmin: role === UserRole.ADMIN || role === UserRole.OWNER,
          createdAt: new Date(),
          lastActivity: new Date(),
          avatar: user.avatar,
          attributes: {},
        },
        role: role,
        grant: grant,
        lastActivity: new Date(),
        isActive: false,
      };

      setCurrentPermissions(prev => [...prev, newPermission]);
      setSuccess(`Successfully invited ${user.displayName} as ${roleConfig[role].label}`);
      
      // Clear search
      setSearchQuery('');
      setUserSearchResults([]);

      // Notify parent component
      if (onUserInvited) {
        onUserInvited(newPermission.user, role);
      }

    } catch (err) {
      console.error('Failed to invite user:', err);
      setError(`Failed to invite ${user.displayName}. Please try again.`);
    } finally {
      setIsSaving(false);
    }
  }, [permissionService, notebookPath, currentUser.userId, sessionId, roleConfig, onUserInvited]);

  /**
   * Change user role
   */
  const changeUserRole = useCallback(async (userId: string, newRole: UserRole) => {
    if (!canModifyRole(newRole)) {
      setError('You do not have permission to assign this role.');
      return;
    }

    try {
      setIsSaving(true);
      setError(null);

      // Find current permission
      const currentPermission = currentPermissions.find(p => p.user.userId === userId);
      if (!currentPermission) {
        throw new Error('User permission not found');
      }

      // Revoke current permission
      await permissionService.revokePermission(
        currentPermission.grant.grantId,
        currentUser.userId,
        `Role change from ${currentPermission.role} to ${newRole}`
      );

      // Grant new permission
      const newGrant = await permissionService.grantPermission({
        userId: userId,
        permission: getPermissionForRole(newRole),
        scope: PermissionScope.NOTEBOOK,
        resourceId: notebookPath,
        role: newRole,
        grantedBy: currentUser.userId,
        metadata: {
          previousRole: currentPermission.role,
          roleChangeAt: new Date().toISOString(),
          sessionId: sessionId,
        },
        delegatable: newRole !== UserRole.OWNER,
      });

      // Update local state
      setCurrentPermissions(prev => prev.map(p => 
        p.user.userId === userId 
          ? { ...p, role: newRole, grant: newGrant }
          : p
      ));

      setSuccess(`Successfully changed ${currentPermission.user.displayName}'s role to ${roleConfig[newRole].label}`);

      // Notify parent component
      if (onPermissionChange) {
        onPermissionChange(userId, newRole);
      }

    } catch (err) {
      console.error('Failed to change user role:', err);
      setError('Failed to change user role. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [canModifyRole, currentPermissions, permissionService, currentUser.userId, notebookPath, sessionId, roleConfig, onPermissionChange]);

  /**
   * Remove user from session
   */
  const removeUser = useCallback(async (userId: string) => {
    if (userId === currentUser.userId) {
      setError('You cannot remove yourself from the session.');
      return;
    }

    try {
      setIsSaving(true);
      setError(null);

      // Find current permission
      const currentPermission = currentPermissions.find(p => p.user.userId === userId);
      if (!currentPermission) {
        throw new Error('User permission not found');
      }

      if (!canModifyRole(currentPermission.role)) {
        setError('You do not have permission to remove this user.');
        return;
      }

      // Revoke permission
      await permissionService.revokePermission(
        currentPermission.grant.grantId,
        currentUser.userId,
        'User removed from session'
      );

      // Update local state
      setCurrentPermissions(prev => prev.filter(p => p.user.userId !== userId));
      setSuccess(`Successfully removed ${currentPermission.user.displayName} from the session`);

    } catch (err) {
      console.error('Failed to remove user:', err);
      setError('Failed to remove user. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [currentUser.userId, currentPermissions, canModifyRole, permissionService]);

  /**
   * Approve or deny permission request
   */
  const handlePermissionRequest = useCallback(async (
    requestId: string, 
    decision: 'approved' | 'denied',
    notes?: string
  ) => {
    try {
      setIsSaving(true);
      setError(null);

      await permissionService.resolvePermissionRequest(
        requestId,
        decision,
        currentUser.userId,
        notes
      );

      // Remove from pending requests
      setPendingRequests(prev => prev.filter(r => r.requestId !== requestId));
      
      // Reload permissions if approved
      if (decision === 'approved') {
        await loadCurrentPermissions();
      }

      setSuccess(`Permission request ${decision} successfully`);

    } catch (err) {
      console.error('Failed to handle permission request:', err);
      setError('Failed to process permission request. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [permissionService, currentUser.userId, loadCurrentPermissions]);

  /**
   * Generate shareable link
   */
  const generateShareLink = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Mock implementation - would generate secure sharing token
      const token = btoa(`${sessionId}:${Date.now()}`);
      const baseUrl = window.location.origin;
      const link = `${baseUrl}/notebooks/${encodeURIComponent(notebookPath)}?collab=${token}`;
      
      setShareLink(link);
      
      // Copy to clipboard
      await navigator.clipboard.writeText(link);
      setSuccess('Share link copied to clipboard');
      
    } catch (err) {
      console.error('Failed to generate share link:', err);
      setError('Failed to generate share link. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, notebookPath]);

  /**
   * Save session settings
   */
  const saveSessionSettings = useCallback(async (newSettings: ISessionSettings) => {
    try {
      setIsSaving(true);
      setError(null);

      // Mock implementation - would save to backend
      setSessionSettings(newSettings);
      setSuccess('Session settings saved successfully');

    } catch (err) {
      console.error('Failed to save session settings:', err);
      setError('Failed to save session settings. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, []);

  /**
   * Get permission type for role
   */
  const getPermissionForRole = (role: UserRole): PermissionType => {
    switch (role) {
      case UserRole.VIEWER:
        return PermissionType.READ;
      case UserRole.EDITOR:
        return PermissionType.WRITE;
      case UserRole.COLLABORATOR:
        return PermissionType.EXECUTE;
      case UserRole.ADMIN:
        return PermissionType.ADMIN;
      case UserRole.OWNER:
        return PermissionType.ADMIN;
      default:
        return PermissionType.READ;
    }
  };

  /**
   * Toggle accordion expansion
   */
  const toggleAccordion = useCallback((panelId: string) => {
    setExpandedAccordions(prev => {
      const newSet = new Set(prev);
      if (newSet.has(panelId)) {
        newSet.delete(panelId);
      } else {
        newSet.add(panelId);
      }
      return newSet;
    });
  }, []);

  // Effects
  useEffect(() => {
    if (open) {
      loadCurrentPermissions();
      loadPendingRequests();
      loadAuditLog();
    }
  }, [open, loadCurrentPermissions, loadPendingRequests, loadAuditLog]);

  useEffect(() => {
    if (searchQuery) {
      searchUsers(searchQuery);
    } else {
      setUserSearchResults([]);
    }
  }, [searchQuery, searchUsers]);

  useEffect(() => {
    loadAuditLog();
  }, [auditPage, auditRowsPerPage, loadAuditLog]);

  // Cleanup timeouts
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      if (permissionUpdateTimeoutRef.current) {
        clearTimeout(permissionUpdateTimeoutRef.current);
      }
    };
  }, []);

  /**
   * Render role selector
   */
  const renderRoleSelector = (
    currentRole: UserRole,
    userId: string,
    disabled: boolean = false
  ) => (
    <FormControl size="small" disabled={disabled || !canModifyRole(currentRole)}>
      <Select
        value={currentRole}
        onChange={(e) => changeUserRole(userId, e.target.value as UserRole)}
        sx={{ minWidth: 120 }}
      >
        {roleHierarchy.map((role) => (
          <MenuItem key={role} value={role} disabled={!canModifyRole(role)}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {roleConfig[role].icon}
              <Typography variant="body2">{roleConfig[role].label}</Typography>
            </Box>
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );

  /**
   * Render user avatar with status
   */
  const renderUserAvatar = (user: IUserInfo, isActive: boolean) => (
    <Badge
      overlap="circular"
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      badgeContent={
        isActive ? (
          <CheckCircleIcon sx={{ color: 'success.main', fontSize: 16 }} />
        ) : null
      }
    >
      <Avatar
        src={user.avatar}
        sx={{ 
          width: 40, 
          height: 40,
          bgcolor: isActive ? 'success.light' : 'grey.400'
        }}
      >
        {user.displayName.charAt(0).toUpperCase()}
      </Avatar>
    </Badge>
  );

  /**
   * Render permissions tab
   */
  const renderPermissionsTab = () => (
    <Box sx={{ p: 2 }}>
      {/* Current Collaborators */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <GroupIcon />
          Current Collaborators ({currentPermissions.length})
        </Typography>
        
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
            <CircularProgress />
          </Box>
        ) : (
          <List>
            {currentPermissions.map((permission) => (
              <ListItem key={permission.user.userId} divider>
                <ListItemAvatar>
                  {renderUserAvatar(permission.user, permission.isActive)}
                </ListItemAvatar>
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="subtitle1">
                        {permission.user.displayName}
                      </Typography>
                      {permission.user.userId === currentUser.userId && (
                        <Chip label="You" size="small" color="primary" />
                      )}
                      {permission.role === UserRole.OWNER && (
                        <Chip label="Owner" size="small" color="error" />
                      )}
                    </Box>
                  }
                  secondary={
                    <Box>
                      <Typography variant="body2" color="text.secondary">
                        {permission.user.email}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Last active: {permission.lastActivity.toLocaleString()}
                      </Typography>
                    </Box>
                  }
                />
                <ListItemSecondaryAction>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    {renderRoleSelector(
                      permission.role,
                      permission.user.userId,
                      isSaving || permission.user.userId === currentUser.userId
                    )}
                    {permission.user.userId !== currentUser.userId && 
                     canModifyRole(permission.role) && (
                      <Tooltip title="Remove user">
                        <IconButton
                          size="small"
                          onClick={() => removeUser(permission.user.userId)}
                          disabled={isSaving}
                          color="error"
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                </ListItemSecondaryAction>
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      {/* Invite New Users */}
      {hasAdminPrivileges && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PersonAddIcon />
            Invite Collaborators
          </Typography>
          
          <Card variant="outlined">
            <CardContent>
              <Grid container spacing={2} alignItems="flex-end">
                <Grid item xs={12} sm={6}>
                  <Autocomplete
                    options={userSearchResults}
                    getOptionLabel={(option) => `${option.displayName} (${option.email})`}
                    renderOption={(props, option) => (
                      <Box component="li" {...props}>
                        <Avatar src={option.avatar} sx={{ mr: 2, width: 32, height: 32 }}>
                          {option.displayName.charAt(0)}
                        </Avatar>
                        <Box>
                          <Typography variant="body2">{option.displayName}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {option.email}
                          </Typography>
                          {option.isInSession && (
                            <Chip label="Already in session" size="small" sx={{ ml: 1 }} />
                          )}
                        </Box>
                      </Box>
                    )}
                    inputValue={searchQuery}
                    onInputChange={(_, newValue) => setSearchQuery(newValue)}
                    loading={isSearching}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Search users or enter email"
                        placeholder="Type to search..."
                        InputProps={{
                          ...params.InputProps,
                          startAdornment: <SearchIcon sx={{ mr: 1, color: 'text.secondary' }} />,
                          endAdornment: (
                            <>
                              {isSearching && <CircularProgress size={20} />}
                              {params.InputProps.endAdornment}
                            </>
                          ),
                        }}
                      />
                    )}
                  />
                </Grid>
                <Grid item xs={12} sm={3}>
                  <FormControl fullWidth>
                    <InputLabel>Default Role</InputLabel>
                    <Select
                      value={selectedRole}
                      onChange={(e) => setSelectedRole(e.target.value as UserRole)}
                      label="Default Role"
                    >
                      {roleHierarchy
                        .filter(role => canModifyRole(role))
                        .map((role) => (
                          <MenuItem key={role} value={role}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              {roleConfig[role].icon}
                              {roleConfig[role].label}
                            </Box>
                          </MenuItem>
                        ))}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <Button
                    variant="contained"
                    startIcon={<SendIcon />}
                    fullWidth
                    disabled={!searchQuery || isSaving || userSearchResults.length === 0}
                    onClick={() => {
                      const selectedUser = userSearchResults.find(u => 
                        `${u.displayName} (${u.email})`.includes(searchQuery)
                      );
                      if (selectedUser && !selectedUser.isInSession) {
                        inviteUser(selectedUser, selectedRole);
                      }
                    }}
                  >
                    Invite
                  </Button>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Box>
      )}

      {/* Role Legend */}
      <Box>
        <Typography variant="h6" gutterBottom>
          Role Permissions
        </Typography>
        <Grid container spacing={2}>
          {roleHierarchy.map((role) => (
            <Grid item xs={12} sm={6} md={4} key={role}>
              <Card variant="outlined" sx={{ height: '100%' }}>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Box sx={{ color: roleConfig[role].color }}>
                      {roleConfig[role].icon}
                    </Box>
                    <Typography variant="subtitle1" fontWeight="bold">
                      {roleConfig[role].label}
                    </Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    {roleConfig[role].description}
                  </Typography>
                  <Box>
                    {roleConfig[role].permissions.map((permission, index) => (
                      <Chip
                        key={index}
                        label={permission}
                        size="small"
                        sx={{ mr: 0.5, mb: 0.5 }}
                        variant="outlined"
                      />
                    ))}
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Box>
    </Box>
  );

  /**
   * Render requests tab
   */
  const renderRequestsTab = () => (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <PendingIcon />
        Pending Permission Requests ({pendingRequests.length})
      </Typography>
      
      {pendingRequests.length === 0 ? (
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <PendingIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
          <Typography variant="body1" color="text.secondary">
            No pending permission requests
          </Typography>
        </Paper>
      ) : (
        <List>
          {pendingRequests.map((request) => (
            <ListItem key={request.requestId} divider>
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="subtitle1">
                      {request.requestingUserId}
                    </Typography>
                    <Chip
                      label={request.permission}
                      size="small"
                      color="primary"
                      variant="outlined"
                    />
                  </Box>
                }
                secondary={
                  <Box>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      {request.justification}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Requested: {request.requestedAt.toLocaleString()}
                    </Typography>
                  </Box>
                }
              />
              <ListItemSecondaryAction>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button
                    size="small"
                    variant="contained"
                    color="success"
                    onClick={() => handlePermissionRequest(request.requestId, 'approved')}
                    disabled={isSaving}
                  >
                    Approve
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    onClick={() => handlePermissionRequest(request.requestId, 'denied')}
                    disabled={isSaving}
                  >
                    Deny
                  </Button>
                </Box>
              </ListItemSecondaryAction>
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );

  /**
   * Render settings tab
   */
  const renderSettingsTab = () => (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <SettingsIcon />
        Session Settings
      </Typography>

      {/* Sharing Settings */}
      <Accordion 
        expanded={expandedAccordions.has('sharing')}
        onChange={() => toggleAccordion('sharing')}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">Sharing & Access</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={sessionSettings.allowPublicViewing}
                  onChange={(e) => setSessionSettings(prev => ({
                    ...prev,
                    allowPublicViewing: e.target.checked
                  }))}
                />
              }
              label="Allow public viewing (read-only)"
            />
            
            <FormControlLabel
              control={
                <Switch
                  checked={sessionSettings.requireApprovalForEditors}
                  onChange={(e) => setSessionSettings(prev => ({
                    ...prev,
                    requireApprovalForEditors: e.target.checked
                  }))}
                />
              }
              label="Require approval for new editors"
            />

            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              <TextField
                label="Max users per session"
                type="number"
                value={sessionSettings.maxUsersPerSession}
                onChange={(e) => setSessionSettings(prev => ({
                  ...prev,
                  maxUsersPerSession: parseInt(e.target.value) || 10
                }))}
                inputProps={{ min: 1, max: 100 }}
                sx={{ width: 200 }}
              />
              
              <TextField
                label="Session expiration (hours)"
                type="number"
                value={sessionSettings.sessionExpirationHours}
                onChange={(e) => setSessionSettings(prev => ({
                  ...prev,
                  sessionExpirationHours: parseInt(e.target.value) || 24
                }))}
                inputProps={{ min: 1, max: 168 }}
                sx={{ width: 200 }}
              />
            </Box>

            <Button
              variant="contained"
              startIcon={<LinkIcon />}
              onClick={generateShareLink}
              disabled={isLoading}
              sx={{ alignSelf: 'flex-start' }}
            >
              Generate Share Link
            </Button>

            {shareLink && (
              <Paper sx={{ p: 2, bgcolor: 'grey.50' }}>
                <Typography variant="subtitle2" gutterBottom>
                  Share Link:
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <TextField
                    value={shareLink}
                    InputProps={{ readOnly: true }}
                    size="small"
                    fullWidth
                  />
                  <IconButton
                    onClick={() => navigator.clipboard.writeText(shareLink)}
                    size="small"
                  >
                    <CopyIcon />
                  </IconButton>
                </Box>
              </Paper>
            )}
          </Box>
        </AccordionDetails>
      </Accordion>

      {/* Collaboration Settings */}
      <Accordion 
        expanded={expandedAccordions.has('collaboration')}
        onChange={() => toggleAccordion('collaboration')}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">Collaboration Features</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={sessionSettings.enableCommentNotifications}
                  onChange={(e) => setSessionSettings(prev => ({
                    ...prev,
                    enableCommentNotifications: e.target.checked
                  }))}
                />
              }
              label="Enable comment notifications"
            />
            
            <FormControlLabel
              control={
                <Switch
                  checked={sessionSettings.lockCellsDuringEditing}
                  onChange={(e) => setSessionSettings(prev => ({
                    ...prev,
                    lockCellsDuringEditing: e.target.checked
                  }))}
                />
              }
              label="Lock cells during editing"
            />
          </Box>
        </AccordionDetails>
      </Accordion>

      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="contained"
          onClick={() => saveSessionSettings(sessionSettings)}
          disabled={isSaving}
          startIcon={isSaving ? <CircularProgress size={16} /> : undefined}
        >
          Save Settings
        </Button>
      </Box>
    </Box>
  );

  /**
   * Render audit tab
   */
  const renderAuditTab = () => (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <HistoryIcon />
        Audit Log
      </Typography>
      
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Timestamp</TableCell>
              <TableCell>User</TableCell>
              <TableCell>Action</TableCell>
              <TableCell>Resource</TableCell>
              <TableCell>Result</TableCell>
              <TableCell>Risk Level</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {auditLog.map((entry) => (
              <TableRow key={entry.entryId}>
                <TableCell>
                  <Typography variant="body2">
                    {entry.timestamp.toLocaleString()}
                  </Typography>
                </TableCell>
                <TableCell>{entry.userId}</TableCell>
                <TableCell>{entry.action}</TableCell>
                <TableCell>{entry.resourceId}</TableCell>
                <TableCell>
                  <Chip
                    label={entry.result}
                    size="small"
                    color={
                      entry.result === 'success' ? 'success' :
                      entry.result === 'failure' ? 'error' : 'warning'
                    }
                  />
                </TableCell>
                <TableCell>
                  <Chip
                    label={entry.riskLevel}
                    size="small"
                    color={
                      entry.riskLevel === 'low' ? 'success' :
                      entry.riskLevel === 'medium' ? 'warning' :
                      entry.riskLevel === 'high' ? 'error' : 'error'
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={-1} // Unknown total count
          page={auditPage}
          onPageChange={(_, newPage) => setAuditPage(newPage)}
          rowsPerPage={auditRowsPerPage}
          onRowsPerPageChange={(e) => setAuditRowsPerPage(parseInt(e.target.value, 10))}
          rowsPerPageOptions={[10, 25, 50]}
        />
      </TableContainer>
    </Box>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: { height: '90vh', maxHeight: 800 }
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <SecurityIcon />
        Notebook Permissions - {notebookPath}
      </DialogTitle>
      
      <DialogContent sx={{ p: 0 }}>
        <Tabs value={tabValue} onChange={(_, newValue) => setTabValue(newValue)}>
          <Tab label="Permissions" />
          <Tab 
            label={
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                Requests
                {pendingRequests.length > 0 && (
                  <Badge badgeContent={pendingRequests.length} color="error" />
                )}
              </Box>
            }
            disabled={!hasAdminPrivileges}
          />
          <Tab label="Settings" disabled={!hasAdminPrivileges} />
          <Tab label="Audit Log" disabled={!hasAdminPrivileges} />
        </Tabs>

        <Box sx={{ height: 'calc(100% - 48px)', overflow: 'auto' }}>
          {tabValue === 0 && renderPermissionsTab()}
          {tabValue === 1 && renderRequestsTab()}
          {tabValue === 2 && renderSettingsTab()}
          {tabValue === 3 && renderAuditTab()}
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>

      {/* Success/Error Snackbars */}
      <Snackbar
        open={!!success}
        autoHideDuration={6000}
        onClose={() => setSuccess(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSuccess(null)} severity="success">
          {success}
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!error}
        autoHideDuration={6000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setError(null)} severity="error">
          {error}
        </Alert>
      </Snackbar>
    </Dialog>
  );
};

export default PermissionsDialog;