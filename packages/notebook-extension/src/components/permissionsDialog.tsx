import React, { useState, useEffect, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { User } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

/**
 * Permission levels for collaborative editing
 */
export enum PermissionLevel {
  VIEW = 'view',
  EDIT = 'edit',
  ADMIN = 'admin'
}

/**
 * Interface for a collaborator in the notebook
 */
export interface ICollaborator {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  permission: PermissionLevel;
  isOnline: boolean;
  lastSeen?: Date;
  addedBy?: string;
  addedAt: Date;
}

/**
 * Interface for permissions manager service
 */
export interface IPermissionsManager {
  /**
   * Current user's permission level
   */
  readonly currentUserPermission: PermissionLevel;
  
  /**
   * List of all collaborators with their permissions
   */
  readonly collaborators: ICollaborator[];
  
  /**
   * Signal emitted when collaborators list changes
   */
  readonly collaboratorsChanged: Signal<this, ICollaborator[]>;
  
  /**
   * Signal emitted when current user's permission changes
   */
  readonly permissionChanged: Signal<this, PermissionLevel>;
  
  /**
   * Add a new collaborator with specified permission level
   */
  addCollaborator(userEmail: string, permission: PermissionLevel): Promise<void>;
  
  /**
   * Update a collaborator's permission level
   */
  updateCollaboratorPermission(userId: string, permission: PermissionLevel): Promise<void>;
  
  /**
   * Remove a collaborator from the notebook
   */
  removeCollaborator(userId: string): Promise<void>;
  
  /**
   * Get current user information
   */
  getCurrentUser(): Promise<User.IUser | null>;
  
  /**
   * Validate if current user can perform admin actions
   */
  canManagePermissions(): boolean;
}

/**
 * Props for the PermissionsDialog component
 */
interface IPermissionsDialogProps {
  permissionsManager: IPermissionsManager;
  translator?: ITranslator;
}

/**
 * React component for managing collaborator permissions
 */
const PermissionsDialog: React.FC<IPermissionsDialogProps> = ({
  permissionsManager,
  translator = nullTranslator
}) => {
  const trans = translator.load('notebook');
  
  // State management
  const [collaborators, setCollaborators] = useState<ICollaborator[]>([]);
  const [currentUser, setCurrentUser] = useState<User.IUser | null>(null);
  const [newCollaboratorEmail, setNewCollaboratorEmail] = useState('');
  const [newCollaboratorPermission, setNewCollaboratorPermission] = useState(PermissionLevel.VIEW);
  const [isAddingCollaborator, setIsAddingCollaborator] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [canManagePermissions, setCanManagePermissions] = useState(false);

  // Load initial data
  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        const user = await permissionsManager.getCurrentUser();
        setCurrentUser(user);
        setCollaborators(permissionsManager.collaborators);
        setCanManagePermissions(permissionsManager.canManagePermissions());
      } catch (error) {
        console.error('Failed to load permissions data:', error);
        setErrorMessage(trans.__('Failed to load permissions data'));
      } finally {
        setIsLoading(false);
      }
    };
    
    loadData();
  }, [permissionsManager, trans]);

  // Listen for permission changes
  useEffect(() => {
    const onCollaboratorsChanged = (sender: IPermissionsManager, collaborators: ICollaborator[]) => {
      setCollaborators(collaborators);
    };
    
    const onPermissionChanged = (sender: IPermissionsManager, permission: PermissionLevel) => {
      setCanManagePermissions(permissionsManager.canManagePermissions());
    };
    
    permissionsManager.collaboratorsChanged.connect(onCollaboratorsChanged);
    permissionsManager.permissionChanged.connect(onPermissionChanged);
    
    return () => {
      permissionsManager.collaboratorsChanged.disconnect(onCollaboratorsChanged);
      permissionsManager.permissionChanged.disconnect(onPermissionChanged);
    };
  }, [permissionsManager]);

  // Handle adding new collaborator
  const handleAddCollaborator = useCallback(async () => {
    if (!newCollaboratorEmail.trim()) {
      setErrorMessage(trans.__('Please enter a valid email address'));
      return;
    }
    
    if (!canManagePermissions) {
      setErrorMessage(trans.__('You do not have permission to add collaborators'));
      return;
    }
    
    try {
      setIsAddingCollaborator(true);
      setErrorMessage('');
      
      await permissionsManager.addCollaborator(newCollaboratorEmail.trim(), newCollaboratorPermission);
      
      // Clear form
      setNewCollaboratorEmail('');
      setNewCollaboratorPermission(PermissionLevel.VIEW);
      
    } catch (error) {
      console.error('Failed to add collaborator:', error);
      setErrorMessage(trans.__('Failed to add collaborator: %1', error.message || 'Unknown error'));
    } finally {
      setIsAddingCollaborator(false);
    }
  }, [newCollaboratorEmail, newCollaboratorPermission, canManagePermissions, permissionsManager, trans]);

  // Handle permission change
  const handlePermissionChange = useCallback(async (userId: string, newPermission: PermissionLevel) => {
    if (!canManagePermissions) {
      setErrorMessage(trans.__('You do not have permission to change collaborator permissions'));
      return;
    }
    
    try {
      setErrorMessage('');
      await permissionsManager.updateCollaboratorPermission(userId, newPermission);
    } catch (error) {
      console.error('Failed to update permission:', error);
      setErrorMessage(trans.__('Failed to update permission: %1', error.message || 'Unknown error'));
    }
  }, [canManagePermissions, permissionsManager, trans]);

  // Handle removing collaborator
  const handleRemoveCollaborator = useCallback(async (userId: string, userName: string) => {
    if (!canManagePermissions) {
      setErrorMessage(trans.__('You do not have permission to remove collaborators'));
      return;
    }
    
    const result = await showDialog({
      title: trans.__('Remove Collaborator'),
      body: trans.__('Are you sure you want to remove %1 from this notebook?', userName),
      buttons: [
        Dialog.cancelButton({ label: trans.__('Cancel') }),
        Dialog.warnButton({ label: trans.__('Remove') })
      ]
    });
    
    if (result.button.accept) {
      try {
        setErrorMessage('');
        await permissionsManager.removeCollaborator(userId);
      } catch (error) {
        console.error('Failed to remove collaborator:', error);
        setErrorMessage(trans.__('Failed to remove collaborator: %1', error.message || 'Unknown error'));
      }
    }
  }, [canManagePermissions, permissionsManager, trans]);

  // Get permission level display name
  const getPermissionDisplayName = (permission: PermissionLevel): string => {
    switch (permission) {
      case PermissionLevel.VIEW:
        return trans.__('View');
      case PermissionLevel.EDIT:
        return trans.__('Edit');
      case PermissionLevel.ADMIN:
        return trans.__('Admin');
      default:
        return trans.__('Unknown');
    }
  };

  // Get permission level description
  const getPermissionDescription = (permission: PermissionLevel): string => {
    switch (permission) {
      case PermissionLevel.VIEW:
        return trans.__('Can view the notebook but cannot make changes');
      case PermissionLevel.EDIT:
        return trans.__('Can edit cells and run code');
      case PermissionLevel.ADMIN:
        return trans.__('Can edit content and manage collaborators');
      default:
        return '';
    }
  };

  // Format last seen time
  const formatLastSeen = (lastSeen?: Date): string => {
    if (!lastSeen) return trans.__('Never');
    
    const now = new Date();
    const diff = now.getTime() - lastSeen.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (minutes < 1) return trans.__('Just now');
    if (minutes < 60) return trans.__('%1 minutes ago', minutes);
    if (hours < 24) return trans.__('%1 hours ago', hours);
    return trans.__('%1 days ago', days);
  };

  if (isLoading) {
    return (
      <div className="jp-PermissionsDialog-loading">
        <div className="jp-PermissionsDialog-spinner" />
        <p>{trans.__('Loading permissions...')}</p>
      </div>
    );
  }

  return (
    <div className="jp-PermissionsDialog">
      <div className="jp-PermissionsDialog-header">
        <h3 className="jp-PermissionsDialog-title">
          {trans.__('Manage Collaborators')}
        </h3>
        <p className="jp-PermissionsDialog-subtitle">
          {trans.__('Control who can access and edit this notebook')}
        </p>
      </div>

      {errorMessage && (
        <div className="jp-PermissionsDialog-error">
          <span className="jp-PermissionsDialog-errorIcon">⚠</span>
          {errorMessage}
        </div>
      )}

      {/* Current User Info */}
      {currentUser && (
        <div className="jp-PermissionsDialog-currentUser">
          <div className="jp-PermissionsDialog-userRow">
            <div className="jp-PermissionsDialog-userInfo">
              <div className="jp-PermissionsDialog-avatar">
                {currentUser.avatar_url ? (
                  <img src={currentUser.avatar_url} alt={currentUser.display_name || currentUser.name} />
                ) : (
                  <div className="jp-PermissionsDialog-avatarPlaceholder">
                    {(currentUser.display_name || currentUser.name || '?').charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="jp-PermissionsDialog-userDetails">
                <div className="jp-PermissionsDialog-userName">
                  {currentUser.display_name || currentUser.name} {trans.__('(You)')}
                </div>
                <div className="jp-PermissionsDialog-userEmail">
                  {currentUser.email || currentUser.name}
                </div>
              </div>
            </div>
            <div className="jp-PermissionsDialog-userPermission">
              <span className="jp-PermissionsDialog-permissionBadge jp-PermissionsDialog-permissionBadge-admin">
                {getPermissionDisplayName(permissionsManager.currentUserPermission)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Add Collaborator Form */}
      {canManagePermissions && (
        <div className="jp-PermissionsDialog-addCollaborator">
          <h4 className="jp-PermissionsDialog-sectionTitle">
            {trans.__('Add Collaborator')}
          </h4>
          <div className="jp-PermissionsDialog-addForm">
            <div className="jp-PermissionsDialog-inputGroup">
              <input
                type="email"
                className="jp-PermissionsDialog-emailInput"
                placeholder={trans.__('Enter email address')}
                value={newCollaboratorEmail}
                onChange={(e) => setNewCollaboratorEmail(e.target.value)}
                disabled={isAddingCollaborator}
              />
              <select
                className="jp-PermissionsDialog-permissionSelect"
                value={newCollaboratorPermission}
                onChange={(e) => setNewCollaboratorPermission(e.target.value as PermissionLevel)}
                disabled={isAddingCollaborator}
              >
                <option value={PermissionLevel.VIEW}>{getPermissionDisplayName(PermissionLevel.VIEW)}</option>
                <option value={PermissionLevel.EDIT}>{getPermissionDisplayName(PermissionLevel.EDIT)}</option>
                <option value={PermissionLevel.ADMIN}>{getPermissionDisplayName(PermissionLevel.ADMIN)}</option>
              </select>
              <button
                className="jp-PermissionsDialog-addButton"
                onClick={handleAddCollaborator}
                disabled={isAddingCollaborator || !newCollaboratorEmail.trim()}
              >
                {isAddingCollaborator ? trans.__('Adding...') : trans.__('Add')}
              </button>
            </div>
            <div className="jp-PermissionsDialog-permissionHelp">
              {getPermissionDescription(newCollaboratorPermission)}
            </div>
          </div>
        </div>
      )}

      {/* Collaborators List */}
      <div className="jp-PermissionsDialog-collaborators">
        <h4 className="jp-PermissionsDialog-sectionTitle">
          {trans.__('Collaborators (%1)', collaborators.length)}
        </h4>
        
        {collaborators.length === 0 ? (
          <div className="jp-PermissionsDialog-empty">
            <p>{trans.__('No collaborators have been added to this notebook yet.')}</p>
            {!canManagePermissions && (
              <p className="jp-PermissionsDialog-emptySubtext">
                {trans.__('You need admin permissions to add collaborators.')}
              </p>
            )}
          </div>
        ) : (
          <div className="jp-PermissionsDialog-collaboratorList">
            {collaborators.map((collaborator) => (
              <div key={collaborator.id} className="jp-PermissionsDialog-collaboratorRow">
                <div className="jp-PermissionsDialog-collaboratorInfo">
                  <div className="jp-PermissionsDialog-avatar">
                    {collaborator.avatar ? (
                      <img src={collaborator.avatar} alt={collaborator.name} />
                    ) : (
                      <div className="jp-PermissionsDialog-avatarPlaceholder">
                        {collaborator.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className={`jp-PermissionsDialog-statusIndicator ${
                      collaborator.isOnline ? 'jp-PermissionsDialog-online' : 'jp-PermissionsDialog-offline'
                    }`} />
                  </div>
                  <div className="jp-PermissionsDialog-collaboratorDetails">
                    <div className="jp-PermissionsDialog-collaboratorName">
                      {collaborator.name}
                    </div>
                    <div className="jp-PermissionsDialog-collaboratorEmail">
                      {collaborator.email || collaborator.id}
                    </div>
                    <div className="jp-PermissionsDialog-collaboratorStatus">
                      {collaborator.isOnline ? trans.__('Online') : trans.__('Last seen: %1', formatLastSeen(collaborator.lastSeen))}
                    </div>
                  </div>
                </div>
                <div className="jp-PermissionsDialog-collaboratorActions">
                  {canManagePermissions ? (
                    <div className="jp-PermissionsDialog-permissionControls">
                      <select
                        className="jp-PermissionsDialog-permissionSelect"
                        value={collaborator.permission}
                        onChange={(e) => handlePermissionChange(collaborator.id, e.target.value as PermissionLevel)}
                      >
                        <option value={PermissionLevel.VIEW}>{getPermissionDisplayName(PermissionLevel.VIEW)}</option>
                        <option value={PermissionLevel.EDIT}>{getPermissionDisplayName(PermissionLevel.EDIT)}</option>
                        <option value={PermissionLevel.ADMIN}>{getPermissionDisplayName(PermissionLevel.ADMIN)}</option>
                      </select>
                      <button
                        className="jp-PermissionsDialog-removeButton"
                        onClick={() => handleRemoveCollaborator(collaborator.id, collaborator.name)}
                        title={trans.__('Remove collaborator')}
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <span className={`jp-PermissionsDialog-permissionBadge jp-PermissionsDialog-permissionBadge-${collaborator.permission}`}>
                      {getPermissionDisplayName(collaborator.permission)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Permission Levels Help */}
      <div className="jp-PermissionsDialog-help">
        <h4 className="jp-PermissionsDialog-sectionTitle">
          {trans.__('Permission Levels')}
        </h4>
        <div className="jp-PermissionsDialog-helpList">
          <div className="jp-PermissionsDialog-helpItem">
            <span className="jp-PermissionsDialog-permissionBadge jp-PermissionsDialog-permissionBadge-view">
              {getPermissionDisplayName(PermissionLevel.VIEW)}
            </span>
            <span className="jp-PermissionsDialog-helpText">
              {getPermissionDescription(PermissionLevel.VIEW)}
            </span>
          </div>
          <div className="jp-PermissionsDialog-helpItem">
            <span className="jp-PermissionsDialog-permissionBadge jp-PermissionsDialog-permissionBadge-edit">
              {getPermissionDisplayName(PermissionLevel.EDIT)}
            </span>
            <span className="jp-PermissionsDialog-helpText">
              {getPermissionDescription(PermissionLevel.EDIT)}
            </span>
          </div>
          <div className="jp-PermissionsDialog-helpItem">
            <span className="jp-PermissionsDialog-permissionBadge jp-PermissionsDialog-permissionBadge-admin">
              {getPermissionDisplayName(PermissionLevel.ADMIN)}
            </span>
            <span className="jp-PermissionsDialog-helpText">
              {getPermissionDescription(PermissionLevel.ADMIN)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * A namespace for PermissionsDialog static methods.
 */
export namespace PermissionsDialog {
  /**
   * Create a new PermissionsDialog widget
   * 
   * @param permissionsManager - The permissions manager instance
   * @param translator - The translator instance
   * @returns A new ReactWidget containing the PermissionsDialog
   */
  export const create = (
    permissionsManager: IPermissionsManager,
    translator?: ITranslator
  ): ReactWidget => {
    return ReactWidget.create(
      <PermissionsDialog 
        permissionsManager={permissionsManager} 
        translator={translator || nullTranslator}
      />
    );
  };

  /**
   * Show the permissions dialog as a modal
   * 
   * @param permissionsManager - The permissions manager instance
   * @param translator - The translator instance
   * @returns A promise that resolves when the dialog is closed
   */
  export const showDialog = async (
    permissionsManager: IPermissionsManager,
    translator?: ITranslator
  ): Promise<Dialog.IResult<void>> => {
    const widget = create(permissionsManager, translator);
    const trans = (translator || nullTranslator).load('notebook');
    
    return showDialog({
      title: trans.__('Manage Collaborators'),
      body: widget,
      buttons: [Dialog.okButton({ label: trans.__('Done') })],
      hasClose: true
    });
  };
}

/**
 * CSS classes for the PermissionsDialog component
 */
const CSS_CLASSES = {
  DIALOG: 'jp-PermissionsDialog',
  HEADER: 'jp-PermissionsDialog-header',
  TITLE: 'jp-PermissionsDialog-title',
  SUBTITLE: 'jp-PermissionsDialog-subtitle',
  ERROR: 'jp-PermissionsDialog-error',
  ERROR_ICON: 'jp-PermissionsDialog-errorIcon',
  LOADING: 'jp-PermissionsDialog-loading',
  SPINNER: 'jp-PermissionsDialog-spinner',
  CURRENT_USER: 'jp-PermissionsDialog-currentUser',
  ADD_COLLABORATOR: 'jp-PermissionsDialog-addCollaborator',
  ADD_FORM: 'jp-PermissionsDialog-addForm',
  INPUT_GROUP: 'jp-PermissionsDialog-inputGroup',
  EMAIL_INPUT: 'jp-PermissionsDialog-emailInput',
  PERMISSION_SELECT: 'jp-PermissionsDialog-permissionSelect',
  ADD_BUTTON: 'jp-PermissionsDialog-addButton',
  PERMISSION_HELP: 'jp-PermissionsDialog-permissionHelp',
  COLLABORATORS: 'jp-PermissionsDialog-collaborators',
  SECTION_TITLE: 'jp-PermissionsDialog-sectionTitle',
  EMPTY: 'jp-PermissionsDialog-empty',
  EMPTY_SUBTEXT: 'jp-PermissionsDialog-emptySubtext',
  COLLABORATOR_LIST: 'jp-PermissionsDialog-collaboratorList',
  COLLABORATOR_ROW: 'jp-PermissionsDialog-collaboratorRow',
  USER_ROW: 'jp-PermissionsDialog-userRow',
  USER_INFO: 'jp-PermissionsDialog-userInfo',
  USER_DETAILS: 'jp-PermissionsDialog-userDetails',
  USER_NAME: 'jp-PermissionsDialog-userName',
  USER_EMAIL: 'jp-PermissionsDialog-userEmail',
  USER_PERMISSION: 'jp-PermissionsDialog-userPermission',
  COLLABORATOR_INFO: 'jp-PermissionsDialog-collaboratorInfo',
  COLLABORATOR_DETAILS: 'jp-PermissionsDialog-collaboratorDetails',
  COLLABORATOR_NAME: 'jp-PermissionsDialog-collaboratorName',
  COLLABORATOR_EMAIL: 'jp-PermissionsDialog-collaboratorEmail',
  COLLABORATOR_STATUS: 'jp-PermissionsDialog-collaboratorStatus',
  COLLABORATOR_ACTIONS: 'jp-PermissionsDialog-collaboratorActions',
  AVATAR: 'jp-PermissionsDialog-avatar',
  AVATAR_PLACEHOLDER: 'jp-PermissionsDialog-avatarPlaceholder',
  STATUS_INDICATOR: 'jp-PermissionsDialog-statusIndicator',
  ONLINE: 'jp-PermissionsDialog-online',
  OFFLINE: 'jp-PermissionsDialog-offline',
  PERMISSION_CONTROLS: 'jp-PermissionsDialog-permissionControls',
  PERMISSION_BADGE: 'jp-PermissionsDialog-permissionBadge',
  PERMISSION_BADGE_VIEW: 'jp-PermissionsDialog-permissionBadge-view',
  PERMISSION_BADGE_EDIT: 'jp-PermissionsDialog-permissionBadge-edit',
  PERMISSION_BADGE_ADMIN: 'jp-PermissionsDialog-permissionBadge-admin',
  REMOVE_BUTTON: 'jp-PermissionsDialog-removeButton',
  HELP: 'jp-PermissionsDialog-help',
  HELP_LIST: 'jp-PermissionsDialog-helpList',
  HELP_ITEM: 'jp-PermissionsDialog-helpItem',
  HELP_TEXT: 'jp-PermissionsDialog-helpText'
};

// Export all interfaces and types
export type { ICollaborator, IPermissionsManager, IPermissionsDialogProps };
export { CSS_CLASSES };