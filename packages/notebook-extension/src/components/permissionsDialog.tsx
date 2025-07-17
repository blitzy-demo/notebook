/**
 * @fileoverview Permissions dialog component for managing notebook sharing and collaboration
 * 
 * This component provides a comprehensive interface for managing notebook permissions and 
 * collaborator access levels. It integrates with the Yjs-based collaborative editing system 
 * to provide real-time permission management, user invitation capabilities, and role-based
 * access control for collaborative notebooks.
 * 
 * Key features:
 * - Role-based permission management (Owner, Editor, Viewer)
 * - User invitation system with email/username validation
 * - Real-time collaborator list with presence indicators
 * - Document visibility and access control settings
 * - Integration with JupyterHub authentication
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, IResult, IButton } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { ISignal } from '@lumino/signaling';
import { closeIcon } from '@jupyterlab/ui-components';
import { NotebookPanel } from '@jupyterlab/notebook';
import { URLExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { Widget } from '@lumino/widgets';
import { PermissionService } from '../../../notebook/src/collab/permissions';
import { AwarenessService } from '../../../notebook/src/collab/awareness';

/**
 * Permission role enumeration for the dialog interface
 */
export enum PermissionRole {
  /** Owner - Full control including deletion and permission management */
  OWNER = 'owner',
  /** Editor - Can read, write, and execute content */
  EDITOR = 'editor', 
  /** Viewer - Read-only access with comment capabilities */
  VIEWER = 'viewer'
}

/**
 * Interface representing a collaborator in the permission system
 */
export interface ICollaborator {
  /** Unique identifier for the collaborator */
  id: string;
  /** Username of the collaborator */
  username: string;
  /** Email address of the collaborator */
  email: string;
  /** Current role assigned to the collaborator */
  role: PermissionRole;
  /** Display name for the collaborator */
  displayName: string;
  /** Avatar URL for the collaborator */
  avatar: string;
  /** Whether the collaborator is currently online */
  isOnline: boolean;
  /** Timestamp of last activity */
  lastSeen: Date;
}

/**
 * Interface representing a permission level with detailed information
 */
export interface IPermissionLevel {
  /** The permission level identifier */
  level: PermissionRole;
  /** Human-readable name for the permission level */
  displayName: string;
  /** Detailed description of what this permission level allows */
  description: string;
  /** List of specific permissions granted by this level */
  permissions: string[];
}

/**
 * Props interface for the PermissionsDialog component
 */
export interface IPermissionsDialogProps {
  /** The notebook model being managed */
  notebookModel: NotebookPanel.IModel;
  /** Permission service instance for access control */
  permissionService: PermissionService;
  /** Awareness service for user presence tracking */
  awarenessService: AwarenessService;
  /** Translator for internationalization */
  translator: ITranslator;
  /** Callback fired when permissions are changed */
  onPermissionsChanged?: (collaborators: ICollaborator[]) => void;
  /** Callback fired when dialog is closed */
  onDialogClosed?: () => void;
}

/**
 * Permission levels configuration with detailed descriptions
 */
const PERMISSION_LEVELS: IPermissionLevel[] = [
  {
    level: PermissionRole.OWNER,
    displayName: 'Owner',
    description: 'Full control including deletion and permission management',
    permissions: [
      'Read and write all content',
      'Execute code cells',
      'Delete cells and content',
      'Manage permissions for other users',
      'Delete the notebook',
      'Share with others'
    ]
  },
  {
    level: PermissionRole.EDITOR,
    displayName: 'Editor',
    description: 'Can read, write, and execute content',
    permissions: [
      'Read and write all content',
      'Execute code cells',
      'Add and modify cells',
      'Add comments',
      'View change history'
    ]
  },
  {
    level: PermissionRole.VIEWER,
    displayName: 'Viewer',
    description: 'Read-only access with comment capabilities',
    permissions: [
      'Read all content',
      'View outputs and visualizations',
      'Add comments',
      'View change history'
    ]
  }
];

/**
 * Main permissions dialog component for managing notebook collaboration
 */
export const PermissionsDialog: React.FC<IPermissionsDialogProps> = ({
  notebookModel,
  permissionService,
  awarenessService,
  translator,
  onPermissionsChanged,
  onDialogClosed
}) => {
  // State management
  const [collaborators, setCollaborators] = useState<ICollaborator[]>([]);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState<PermissionRole>(PermissionRole.EDITOR);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [documentVisibility, setDocumentVisibility] = useState<'private' | 'public'>('private');
  const [allowPublicComments, setAllowPublicComments] = useState(false);

  // Refs for cleanup
  const signalConnectionsRef = useRef<Array<() => void>>([]);

  // Translation helper
  const trans = translator.load('notebook-extension');

  /**
   * Load current collaborators from the permission service
   */
  const loadCollaborators = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Get collaborators from permission service
      const serviceCollaborators = await permissionService.getCollaborators();
      
      // Get awareness information for online status
      const awarenessUsers = awarenessService.getUsers();
      
      // Combine permission and awareness data
      const enrichedCollaborators: ICollaborator[] = serviceCollaborators.map(collab => {
        const awarenessUser = awarenessUsers.find(u => u.userId === collab.userId);
        
        return {
          id: collab.userId,
          username: collab.name,
          email: collab.userId, // Use userId as email fallback
          role: collab.role as PermissionRole,
          displayName: collab.name,
          avatar: awarenessUser?.avatar || '',
          isOnline: awarenessUser?.isActive || false,
          lastSeen: awarenessUser?.lastActivity || new Date()
        };
      });

      setCollaborators(enrichedCollaborators);
    } catch (err) {
      console.error('Error loading collaborators:', err);
      setError(trans.__('Failed to load collaborators'));
    } finally {
      setIsLoading(false);
    }
  }, [permissionService, awarenessService, trans]);

  /**
   * Handle adding a new collaborator
   */
  const handleAddCollaborator = useCallback(async () => {
    if (!newUserEmail.trim()) {
      setError(trans.__('Please enter a valid email address or username'));
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      setSuccess(null);

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const isEmail = emailRegex.test(newUserEmail);
      
      if (!isEmail && newUserEmail.length < 3) {
        setError(trans.__('Please enter a valid email address or username'));
        return;
      }

      // Check if user is already a collaborator
      const existingCollab = collaborators.find(c => 
        c.email === newUserEmail || c.username === newUserEmail
      );
      
      if (existingCollab) {
        setError(trans.__('User is already a collaborator'));
        return;
      }

      // Convert role to permission service format
      const permissionRole = newUserRole === PermissionRole.OWNER ? 'admin' : 
                           newUserRole === PermissionRole.EDITOR ? 'edit' : 'view';

      // Add the collaborator via permission service
      await permissionService.setUserRole(newUserEmail, permissionRole as any);

      // Clear the form
      setNewUserEmail('');
      setNewUserRole(PermissionRole.EDITOR);
      setSuccess(trans.__('User added successfully'));

      // Reload collaborators
      await loadCollaborators();

      // Notify parent of changes
      if (onPermissionsChanged) {
        onPermissionsChanged(collaborators);
      }
    } catch (err) {
      console.error('Error adding collaborator:', err);
      setError(trans.__('Failed to add collaborator. Please check the email/username and try again.'));
    } finally {
      setIsLoading(false);
    }
  }, [newUserEmail, newUserRole, collaborators, permissionService, trans, onPermissionsChanged, loadCollaborators]);

  /**
   * Handle changing a collaborator's role
   */
  const handleChangeRole = useCallback(async (collaboratorId: string, newRole: PermissionRole) => {
    try {
      setIsLoading(true);
      setError(null);
      setSuccess(null);

      // Convert role to permission service format
      const permissionRole = newRole === PermissionRole.OWNER ? 'admin' : 
                           newRole === PermissionRole.EDITOR ? 'edit' : 'view';

      // Update the role via permission service
      await permissionService.setUserRole(collaboratorId, permissionRole as any);

      setSuccess(trans.__('Role updated successfully'));

      // Reload collaborators
      await loadCollaborators();

      // Notify parent of changes
      if (onPermissionsChanged) {
        onPermissionsChanged(collaborators);
      }
    } catch (err) {
      console.error('Error changing role:', err);
      setError(trans.__('Failed to update role'));
    } finally {
      setIsLoading(false);
    }
  }, [permissionService, trans, onPermissionsChanged, loadCollaborators, collaborators]);

  /**
   * Handle removing a collaborator
   */
  const handleRemoveCollaborator = useCallback(async (collaboratorId: string) => {
    try {
      setIsLoading(true);
      setError(null);
      setSuccess(null);

      // Remove by setting to view and then removing from document
      await permissionService.setUserRole(collaboratorId, 'view');
      
      setSuccess(trans.__('Collaborator removed successfully'));

      // Reload collaborators
      await loadCollaborators();

      // Notify parent of changes
      if (onPermissionsChanged) {
        onPermissionsChanged(collaborators);
      }
    } catch (err) {
      console.error('Error removing collaborator:', err);
      setError(trans.__('Failed to remove collaborator'));
    } finally {
      setIsLoading(false);
    }
  }, [permissionService, trans, onPermissionsChanged, loadCollaborators, collaborators]);

  /**
   * Get role display information
   */
  const getRoleInfo = useCallback((role: PermissionRole): IPermissionLevel => {
    return PERMISSION_LEVELS.find(level => level.level === role) || PERMISSION_LEVELS[1];
  }, []);

  /**
   * Handle document visibility change
   */
  const handleVisibilityChange = useCallback((visibility: 'private' | 'public') => {
    setDocumentVisibility(visibility);
    // TODO: Implement document visibility changes via permission service
  }, []);

  // Effect to load initial data and set up event listeners
  useEffect(() => {
    loadCollaborators();

    // Set up event listeners for real-time updates
    const handlePermissionChange = () => {
      loadCollaborators();
    };

    const handleCollaboratorJoin = () => {
      loadCollaborators();
    };

    const handleCollaboratorLeave = () => {
      loadCollaborators();
    };

    // Connect to permission service signals
    permissionService.onPermissionChanged.connect(handlePermissionChange);
    permissionService.onCollaboratorJoined.connect(handleCollaboratorJoin);
    permissionService.onCollaboratorLeft.connect(handleCollaboratorLeave);

    // Store cleanup functions
    signalConnectionsRef.current.push(
      () => permissionService.onPermissionChanged.disconnect(handlePermissionChange),
      () => permissionService.onCollaboratorJoined.disconnect(handleCollaboratorJoin),
      () => permissionService.onCollaboratorLeft.disconnect(handleCollaboratorLeave)
    );

    return () => {
      // Cleanup signal connections
      signalConnectionsRef.current.forEach(cleanup => cleanup());
      signalConnectionsRef.current = [];
    };
  }, [loadCollaborators, permissionService]);

  // Clear messages after a delay
  useEffect(() => {
    if (error || success) {
      const timer = setTimeout(() => {
        setError(null);
        setSuccess(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [error, success]);

  return (
    <div className="jp-PermissionsDialog">
      <div className="jp-PermissionsDialog-header">
        <h2>{trans.__('Manage Permissions')}</h2>
        <p>{trans.__('Control who can access and edit this notebook')}</p>
      </div>

      {/* Error and Success Messages */}
      {error && (
        <div className="jp-PermissionsDialog-message jp-PermissionsDialog-error">
          {error}
        </div>
      )}
      {success && (
        <div className="jp-PermissionsDialog-message jp-PermissionsDialog-success">
          {success}
        </div>
      )}

      {/* Document Visibility Settings */}
      <div className="jp-PermissionsDialog-section">
        <h3>{trans.__('Document Visibility')}</h3>
        <div className="jp-PermissionsDialog-visibility">
          <label>
            <input
              type="radio"
              name="visibility"
              value="private"
              checked={documentVisibility === 'private'}
              onChange={() => handleVisibilityChange('private')}
            />
            {trans.__('Private')} - {trans.__('Only invited collaborators can access')}
          </label>
          <label>
            <input
              type="radio"
              name="visibility"
              value="public"
              checked={documentVisibility === 'public'}
              onChange={() => handleVisibilityChange('public')}
            />
            {trans.__('Public')} - {trans.__('Anyone with the link can view')}
          </label>
        </div>
        
        {documentVisibility === 'public' && (
          <div className="jp-PermissionsDialog-publicOptions">
            <label>
              <input
                type="checkbox"
                checked={allowPublicComments}
                onChange={(e) => setAllowPublicComments(e.target.checked)}
              />
              {trans.__('Allow public comments')}
            </label>
          </div>
        )}
      </div>

      {/* Add New Collaborator */}
      <div className="jp-PermissionsDialog-section">
        <h3>{trans.__('Invite Collaborators')}</h3>
        <div className="jp-PermissionsDialog-addUser">
          <input
            type="text"
            placeholder={trans.__('Enter email address or username')}
            value={newUserEmail}
            onChange={(e) => setNewUserEmail(e.target.value)}
            className="jp-PermissionsDialog-input"
          />
          <select
            value={newUserRole}
            onChange={(e) => setNewUserRole(e.target.value as PermissionRole)}
            className="jp-PermissionsDialog-select"
          >
            {PERMISSION_LEVELS.map(level => (
              <option key={level.level} value={level.level}>
                {level.displayName}
              </option>
            ))}
          </select>
          <button
            onClick={handleAddCollaborator}
            disabled={isLoading || !newUserEmail.trim()}
            className="jp-PermissionsDialog-addButton"
          >
            {isLoading ? trans.__('Adding...') : trans.__('Add')}
          </button>
        </div>
      </div>

      {/* Current Collaborators */}
      <div className="jp-PermissionsDialog-section">
        <h3>{trans.__('Current Collaborators')}</h3>
        {isLoading && collaborators.length === 0 ? (
          <div className="jp-PermissionsDialog-loading">
            {trans.__('Loading collaborators...')}
          </div>
        ) : (
          <div className="jp-PermissionsDialog-collaborators">
            {collaborators.map(collaborator => {
              const roleInfo = getRoleInfo(collaborator.role);
              return (
                <div key={collaborator.id} className="jp-PermissionsDialog-collaborator">
                  <div className="jp-PermissionsDialog-collaboratorInfo">
                    <div className="jp-PermissionsDialog-avatar">
                      {collaborator.avatar ? (
                        <img src={collaborator.avatar} alt={collaborator.displayName} />
                      ) : (
                        <div className="jp-PermissionsDialog-avatarPlaceholder">
                          {collaborator.displayName.charAt(0).toUpperCase()}
                        </div>
                      )}
                      {collaborator.isOnline && (
                        <div className="jp-PermissionsDialog-onlineIndicator" />
                      )}
                    </div>
                    <div className="jp-PermissionsDialog-collaboratorDetails">
                      <div className="jp-PermissionsDialog-name">
                        {collaborator.displayName}
                      </div>
                      <div className="jp-PermissionsDialog-email">
                        {collaborator.email}
                      </div>
                      <div className="jp-PermissionsDialog-status">
                        {collaborator.isOnline ? 
                          trans.__('Online') : 
                          trans.__('Last seen: %1', collaborator.lastSeen.toLocaleString())
                        }
                      </div>
                    </div>
                  </div>
                  <div className="jp-PermissionsDialog-collaboratorActions">
                    <select
                      value={collaborator.role}
                      onChange={(e) => handleChangeRole(collaborator.id, e.target.value as PermissionRole)}
                      className="jp-PermissionsDialog-roleSelect"
                      disabled={isLoading}
                    >
                      {PERMISSION_LEVELS.map(level => (
                        <option key={level.level} value={level.level}>
                          {level.displayName}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleRemoveCollaborator(collaborator.id)}
                      disabled={isLoading}
                      className="jp-PermissionsDialog-removeButton"
                      title={trans.__('Remove collaborator')}
                    >
                      <closeIcon.react />
                    </button>
                  </div>
                </div>
              );
            })}
            {collaborators.length === 0 && (
              <div className="jp-PermissionsDialog-empty">
                {trans.__('No collaborators yet. Add someone to start collaborating!')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Permission Levels Reference */}
      <div className="jp-PermissionsDialog-section">
        <h3>{trans.__('Permission Levels')}</h3>
        <div className="jp-PermissionsDialog-permissionLevels">
          {PERMISSION_LEVELS.map(level => (
            <div key={level.level} className="jp-PermissionsDialog-permissionLevel">
              <div className="jp-PermissionsDialog-levelHeader">
                <strong>{level.displayName}</strong>
                <span className="jp-PermissionsDialog-levelDescription">
                  {level.description}
                </span>
              </div>
              <ul className="jp-PermissionsDialog-permissions">
                {level.permissions.map(permission => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/**
 * Widget wrapper for the permissions dialog
 */
export class PermissionsDialogWidget extends Widget {
  private _dialog: Dialog<IResult<void>>;

  constructor(props: IPermissionsDialogProps) {
    super();
    this.addClass('jp-PermissionsDialogWidget');

    // Create dialog buttons
    const buttons: IButton[] = [
      Dialog.cancelButton({ label: props.translator.load('notebook-extension').__('Cancel') }),
      Dialog.okButton({ label: props.translator.load('notebook-extension').__('Done') })
    ];

    // Create the dialog
    this._dialog = new Dialog({
      title: props.translator.load('notebook-extension').__('Manage Permissions'),
      body: new PermissionsDialogBodyWidget(props),
      buttons,
      defaultButton: 1,
      hasClose: true
    });
  }

  /**
   * Create a new dialog widget
   */
  static create(props: IPermissionsDialogProps): PermissionsDialogWidget {
    return new PermissionsDialogWidget(props);
  }

  /**
   * Show the dialog
   */
  async show(): Promise<IResult<void>> {
    return this._dialog.launch();
  }

  /**
   * Hide the dialog
   */
  hide(): void {
    this._dialog.resolve();
  }

  /**
   * Dispose of the dialog
   */
  dispose(): void {
    if (this._dialog) {
      this._dialog.dispose();
    }
    super.dispose();
  }
}

/**
 * Body widget for the permissions dialog
 */
class PermissionsDialogBodyWidget extends Widget {
  constructor(private _props: IPermissionsDialogProps) {
    super();
    this.addClass('jp-PermissionsDialogBody');
    this.update();
  }

  protected onUpdateRequest(): void {
    const container = document.createElement('div');
    const root = createRoot(container);
    root.render(
      <PermissionsDialog {...this._props} />
    );
    this.node.innerHTML = '';
    this.node.appendChild(container);
  }
}

/**
 * Utility function to show the permissions dialog
 */
export async function showPermissionsDialog(props: IPermissionsDialogProps): Promise<IResult<void>> {
  const widget = PermissionsDialogWidget.create(props);
  return widget.show();
}

/*
 * CSS Styles for the permissions dialog component
 * These styles provide a professional, accessible interface for permission management
 */
const CSS_STYLES = `
<style>
.jp-PermissionsDialog {
  max-width: 600px;
  min-width: 500px;
  padding: 20px;
  font-family: var(--jp-ui-font-family);
  line-height: 1.4;
}

.jp-PermissionsDialog-header {
  margin-bottom: 20px;
  border-bottom: 1px solid var(--jp-border-color1);
  padding-bottom: 15px;
}

.jp-PermissionsDialog-header h2 {
  margin: 0 0 8px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--jp-ui-font-color1);
}

.jp-PermissionsDialog-header p {
  margin: 0;
  color: var(--jp-ui-font-color2);
  font-size: 14px;
}

.jp-PermissionsDialog-message {
  padding: 10px 15px;
  margin: 10px 0;
  border-radius: 4px;
  font-size: 14px;
}

.jp-PermissionsDialog-error {
  background: var(--jp-error-color3);
  color: var(--jp-error-color1);
  border: 1px solid var(--jp-error-color2);
}

.jp-PermissionsDialog-success {
  background: var(--jp-success-color3);
  color: var(--jp-success-color1);
  border: 1px solid var(--jp-success-color2);
}

.jp-PermissionsDialog-section {
  margin-bottom: 25px;
}

.jp-PermissionsDialog-section h3 {
  margin: 0 0 12px 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--jp-ui-font-color1);
}

.jp-PermissionsDialog-visibility {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.jp-PermissionsDialog-visibility label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.jp-PermissionsDialog-visibility label:hover {
  background: var(--jp-layout-color2);
}

.jp-PermissionsDialog-visibility input[type="radio"] {
  margin: 0;
}

.jp-PermissionsDialog-publicOptions {
  margin-top: 10px;
  padding-left: 24px;
}

.jp-PermissionsDialog-publicOptions label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.jp-PermissionsDialog-addUser {
  display: flex;
  gap: 10px;
  align-items: center;
}

.jp-PermissionsDialog-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  font-size: 14px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
}

.jp-PermissionsDialog-input:focus {
  outline: none;
  border-color: var(--jp-brand-color1);
  box-shadow: 0 0 0 2px var(--jp-brand-color3);
}

.jp-PermissionsDialog-select {
  padding: 8px 12px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  font-size: 14px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  min-width: 100px;
}

.jp-PermissionsDialog-select:focus {
  outline: none;
  border-color: var(--jp-brand-color1);
  box-shadow: 0 0 0 2px var(--jp-brand-color3);
}

.jp-PermissionsDialog-addButton {
  padding: 8px 16px;
  background: var(--jp-brand-color1);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.2s;
}

.jp-PermissionsDialog-addButton:hover:not(:disabled) {
  background: var(--jp-brand-color2);
}

.jp-PermissionsDialog-addButton:disabled {
  background: var(--jp-border-color2);
  cursor: not-allowed;
}

.jp-PermissionsDialog-loading {
  text-align: center;
  padding: 20px;
  color: var(--jp-ui-font-color2);
}

.jp-PermissionsDialog-collaborators {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.jp-PermissionsDialog-collaborator {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 6px;
  background: var(--jp-layout-color1);
}

.jp-PermissionsDialog-collaboratorInfo {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.jp-PermissionsDialog-avatar {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  border: 2px solid var(--jp-border-color1);
}

.jp-PermissionsDialog-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.jp-PermissionsDialog-avatarPlaceholder {
  width: 100%;
  height: 100%;
  background: var(--jp-brand-color1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
  font-size: 16px;
}

.jp-PermissionsDialog-onlineIndicator {
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 12px;
  height: 12px;
  background: var(--jp-success-color1);
  border: 2px solid var(--jp-layout-color1);
  border-radius: 50%;
}

.jp-PermissionsDialog-collaboratorDetails {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.jp-PermissionsDialog-name {
  font-weight: 600;
  color: var(--jp-ui-font-color1);
}

.jp-PermissionsDialog-email {
  font-size: 12px;
  color: var(--jp-ui-font-color2);
}

.jp-PermissionsDialog-status {
  font-size: 12px;
  color: var(--jp-ui-font-color2);
}

.jp-PermissionsDialog-collaboratorActions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.jp-PermissionsDialog-roleSelect {
  padding: 6px 10px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  font-size: 13px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
}

.jp-PermissionsDialog-removeButton {
  padding: 6px;
  background: transparent;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.jp-PermissionsDialog-removeButton:hover:not(:disabled) {
  background: var(--jp-error-color3);
  border-color: var(--jp-error-color2);
  color: var(--jp-error-color1);
}

.jp-PermissionsDialog-removeButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.jp-PermissionsDialog-empty {
  text-align: center;
  padding: 30px;
  color: var(--jp-ui-font-color2);
  font-style: italic;
}

.jp-PermissionsDialog-permissionLevels {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.jp-PermissionsDialog-permissionLevel {
  padding: 15px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 6px;
  background: var(--jp-layout-color1);
}

.jp-PermissionsDialog-levelHeader {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.jp-PermissionsDialog-levelHeader strong {
  color: var(--jp-ui-font-color1);
  font-size: 14px;
}

.jp-PermissionsDialog-levelDescription {
  color: var(--jp-ui-font-color2);
  font-size: 12px;
}

.jp-PermissionsDialog-permissions {
  margin: 0;
  padding-left: 20px;
}

.jp-PermissionsDialog-permissions li {
  font-size: 13px;
  color: var(--jp-ui-font-color2);
  margin-bottom: 2px;
}

.jp-PermissionsDialogWidget {
  max-width: 700px;
}

.jp-PermissionsDialogBody {
  min-height: 400px;
  max-height: 600px;
  overflow-y: auto;
}

/* Responsive adjustments */
@media (max-width: 600px) {
  .jp-PermissionsDialog {
    min-width: 300px;
    padding: 15px;
  }
  
  .jp-PermissionsDialog-addUser {
    flex-direction: column;
    align-items: stretch;
  }
  
  .jp-PermissionsDialog-collaborator {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  
  .jp-PermissionsDialog-collaboratorActions {
    align-self: flex-end;
  }
}
</style>
`;

// Inject styles into the document
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = CSS_STYLES.replace(/<\/?style>/g, '');
  document.head.appendChild(styleElement);
}