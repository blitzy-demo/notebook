import { ReactWidget } from '@jupyterlab/apputils';

import { ITranslator } from '@jupyterlab/translation';

import { Modal } from '@jupyterlab/ui-components';

import React, { useEffect, useState, useCallback } from 'react';

/**
 * Interface for user collaborator information
 */
export interface ICollaborator {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
  isCurrentUser?: boolean;
}

/**
 * User role types for permissions
 */
export type UserRole = 'owner' | 'editor' | 'commenter' | 'viewer';

/**
 * Permission scope types
 */
export type PermissionScope = 'notebook' | 'cell';

/**
 * Role capabilities definition
 */
export interface IRoleCapabilities {
  view: boolean;
  comment: boolean;
  edit: boolean;
  manage: boolean;
}

/**
 * Permissions service interface (matches IPermissionsService)
 */
export interface IPermissionsService {
  /**
   * Get all collaborators for the current document
   */
  getCollaborators(): Promise<ICollaborator[]>;

  /**
   * Add a new collaborator with specified role
   */
  addCollaborator(email: string, role: UserRole, scope?: PermissionScope, cellId?: string): Promise<void>;

  /**
   * Update collaborator role
   */
  updateCollaboratorRole(userId: string, role: UserRole, scope?: PermissionScope, cellId?: string): Promise<void>;

  /**
   * Remove a collaborator
   */
  removeCollaborator(userId: string, scope?: PermissionScope, cellId?: string): Promise<void>;

  /**
   * Get role capabilities
   */
  getRoleCapabilities(role: UserRole): IRoleCapabilities;

  /**
   * Check if current user can manage permissions
   */
  canManagePermissions(): boolean;

  /**
   * Get available roles for assignment
   */
  getAvailableRoles(): UserRole[];
}

/**
 * Props for the PermissionsDialog component
 */
interface IPermissionsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  permissionsService: IPermissionsService;
  translator: ITranslator;
  notebookPath: string;
  selectedCellId?: string;
}

/**
 * A React component for managing collaborative permissions
 */
const PermissionsDialog = ({
  isOpen,
  onClose,
  permissionsService,
  translator,
  notebookPath,
  selectedCellId
}: IPermissionsDialogProps): JSX.Element => {
  const trans = translator.load('notebook');
  
  // State management
  const [collaborators, setCollaborators] = useState<ICollaborator[]>([]);
  const [scope, setScope] = useState<PermissionScope>(selectedCellId ? 'cell' : 'notebook');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCollaboratorEmail, setNewCollaboratorEmail] = useState('');
  const [isAddingCollaborator, setIsAddingCollaborator] = useState(false);

  // Role definitions with capabilities
  const roleCapabilities: Record<UserRole, IRoleCapabilities> = {
    owner: { view: true, comment: true, edit: true, manage: true },
    editor: { view: true, comment: true, edit: true, manage: false },
    commenter: { view: true, comment: true, edit: false, manage: false },
    viewer: { view: true, comment: false, edit: false, manage: false }
  };

  // Load collaborators when dialog opens
  const loadCollaborators = useCallback(async () => {
    if (!isOpen) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const collab = await permissionsService.getCollaborators();
      setCollaborators(collab);
    } catch (err) {
      setError(trans.__('Failed to load collaborators: %1', err instanceof Error ? err.message : String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [isOpen, permissionsService, trans]);

  useEffect(() => {
    loadCollaborators();
  }, [loadCollaborators]);

  // Handle role change for existing collaborator
  const handleRoleChange = useCallback(async (userId: string, newRole: UserRole) => {
    if (!permissionsService.canManagePermissions()) {
      setError(trans.__('You do not have permission to manage roles'));
      return;
    }

    try {
      await permissionsService.updateCollaboratorRole(
        userId, 
        newRole, 
        scope, 
        scope === 'cell' ? selectedCellId : undefined
      );
      
      // Update local state
      setCollaborators(prev => 
        prev.map(collab => 
          collab.id === userId ? { ...collab, role: newRole } : collab
        )
      );
      
      setError(null);
    } catch (err) {
      setError(trans.__('Failed to update role: %1', err instanceof Error ? err.message : String(err)));
    }
  }, [permissionsService, scope, selectedCellId, trans]);

  // Handle adding new collaborator
  const handleAddCollaborator = useCallback(async () => {
    if (!newCollaboratorEmail.trim()) {
      setError(trans.__('Please enter a valid email address'));
      return;
    }

    if (!permissionsService.canManagePermissions()) {
      setError(trans.__('You do not have permission to add collaborators'));
      return;
    }

    setIsAddingCollaborator(true);
    setError(null);

    try {
      await permissionsService.addCollaborator(
        newCollaboratorEmail.trim(),
        'viewer', // Default role
        scope,
        scope === 'cell' ? selectedCellId : undefined
      );
      
      setNewCollaboratorEmail('');
      await loadCollaborators(); // Refresh list
    } catch (err) {
      setError(trans.__('Failed to add collaborator: %1', err instanceof Error ? err.message : String(err)));
    } finally {
      setIsAddingCollaborator(false);
    }
  }, [newCollaboratorEmail, permissionsService, scope, selectedCellId, trans, loadCollaborators]);

  // Handle removing collaborator
  const handleRemoveCollaborator = useCallback(async (userId: string) => {
    if (!permissionsService.canManagePermissions()) {
      setError(trans.__('You do not have permission to remove collaborators'));
      return;
    }

    try {
      await permissionsService.removeCollaborator(
        userId,
        scope,
        scope === 'cell' ? selectedCellId : undefined
      );
      
      // Update local state
      setCollaborators(prev => prev.filter(collab => collab.id !== userId));
      setError(null);
    } catch (err) {
      setError(trans.__('Failed to remove collaborator: %1', err instanceof Error ? err.message : String(err)));
    }
  }, [permissionsService, scope, selectedCellId, trans]);

  // Handle scope change
  const handleScopeChange = useCallback((newScope: PermissionScope) => {
    setScope(newScope);
    loadCollaborators(); // Reload collaborators for new scope
  }, [loadCollaborators]);

  // Handle dialog close with cleanup
  const handleClose = useCallback(() => {
    setError(null);
    setNewCollaboratorEmail('');
    onClose();
  }, [onClose]);

  // Handle save action
  const handleSave = useCallback(() => {
    // All changes are saved immediately, so just close
    handleClose();
  }, [handleClose]);

  if (!isOpen) {
    return <div />;
  }

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      size="large"
      className="jp-PermissionsDialog"
      aria-labelledby="permissions-dialog-title"
    >
      <div className="jp-PermissionsDialog-header">
        <h2 id="permissions-dialog-title" className="jp-PermissionsDialog-title">
          {trans.__('Permissions - %1', notebookPath.split('/').pop() || notebookPath)}
        </h2>
        <button
          className="jp-PermissionsDialog-close"
          onClick={handleClose}
          title={trans.__('Close')}
          aria-label={trans.__('Close')}
        >
          ✕
        </button>
      </div>

      <div className="jp-PermissionsDialog-content">
        {/* Error display */}
        {error && (
          <div className="jp-PermissionsDialog-error" role="alert">
            {error}
          </div>
        )}

        <div className="jp-PermissionsDialog-main">
          {/* Scope selection */}
          <div className="jp-PermissionsDialog-scope">
            <h3>{trans.__('Scope:')}</h3>
            <div className="jp-PermissionsDialog-scopeOptions">
              <label className="jp-PermissionsDialog-scopeOption">
                <input
                  type="radio"
                  name="scope"
                  value="notebook"
                  checked={scope === 'notebook'}
                  onChange={() => handleScopeChange('notebook')}
                />
                {trans.__('Notebook')}
              </label>
              {selectedCellId && (
                <label className="jp-PermissionsDialog-scopeOption">
                  <input
                    type="radio"
                    name="scope"
                    value="cell"
                    checked={scope === 'cell'}
                    onChange={() => handleScopeChange('cell')}
                  />
                  {trans.__('Cell #%1', selectedCellId)}
                </label>
              )}
            </div>
          </div>

          {/* Collaborators section */}
          <div className="jp-PermissionsDialog-collaborators">
            <h3>{trans.__('Collaborators')}</h3>
            
            {isLoading ? (
              <div className="jp-PermissionsDialog-loading">
                {trans.__('Loading collaborators...')}
              </div>
            ) : (
              <div className="jp-PermissionsDialog-collaboratorsList">
                <div className="jp-PermissionsDialog-collaboratorsHeader">
                  <span className="jp-PermissionsDialog-headerName">{trans.__('Name')}</span>
                  <span className="jp-PermissionsDialog-headerEmail">{trans.__('Email')}</span>
                  <span className="jp-PermissionsDialog-headerRole">{trans.__('Role')}</span>
                  <span className="jp-PermissionsDialog-headerActions">{trans.__('Actions')}</span>
                </div>
                
                {collaborators.map(collaborator => (
                  <div key={collaborator.id} className="jp-PermissionsDialog-collaboratorRow">
                    <div className="jp-PermissionsDialog-collaboratorName">
                      {collaborator.avatar && (
                        <img 
                          src={collaborator.avatar} 
                          alt="" 
                          className="jp-PermissionsDialog-avatar"
                        />
                      )}
                      <span>
                        {collaborator.name}
                        {collaborator.isCurrentUser && (
                          <span className="jp-PermissionsDialog-currentUserBadge">
                            {trans.__(' (You)')}
                          </span>
                        )}
                      </span>
                    </div>
                    
                    <div className="jp-PermissionsDialog-collaboratorEmail">
                      {collaborator.email}
                    </div>
                    
                    <div className="jp-PermissionsDialog-collaboratorRole">
                      {collaborator.isCurrentUser && collaborator.role === 'owner' ? (
                        <span className="jp-PermissionsDialog-fixedRole">
                          {trans.__(collaborator.role.charAt(0).toUpperCase() + collaborator.role.slice(1))}
                        </span>
                      ) : (
                        <select
                          value={collaborator.role}
                          onChange={(e) => handleRoleChange(collaborator.id, e.target.value as UserRole)}
                          disabled={!permissionsService.canManagePermissions()}
                          className="jp-PermissionsDialog-roleSelect"
                        >
                          {permissionsService.getAvailableRoles().map(role => (
                            <option key={role} value={role}>
                              {trans.__(role.charAt(0).toUpperCase() + role.slice(1))}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    
                    <div className="jp-PermissionsDialog-collaboratorActions">
                      {!collaborator.isCurrentUser && permissionsService.canManagePermissions() && (
                        <button
                          onClick={() => handleRemoveCollaborator(collaborator.id)}
                          className="jp-PermissionsDialog-removeButton"
                          title={trans.__('Remove collaborator')}
                          aria-label={trans.__('Remove %1', collaborator.name)}
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                {/* Add collaborator row */}
                {permissionsService.canManagePermissions() && (
                  <div className="jp-PermissionsDialog-addCollaborator">
                    <input
                      type="email"
                      placeholder={trans.__('Enter email address')}
                      value={newCollaboratorEmail}
                      onChange={(e) => setNewCollaboratorEmail(e.target.value)}
                      className="jp-PermissionsDialog-emailInput"
                      disabled={isAddingCollaborator}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter') {
                          handleAddCollaborator();
                        }
                      }}
                    />
                    <button
                      onClick={handleAddCollaborator}
                      disabled={isAddingCollaborator || !newCollaboratorEmail.trim()}
                      className="jp-PermissionsDialog-addButton"
                    >
                      {isAddingCollaborator ? trans.__('Adding...') : trans.__('+ Add Collaborator')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Role capabilities table */}
        <div className="jp-PermissionsDialog-rolesTable">
          <h3>{trans.__('Available Roles:')}</h3>
          <table className="jp-PermissionsDialog-capabilitiesTable">
            <thead>
              <tr>
                <th>{trans.__('Role')}</th>
                <th>{trans.__('View')}</th>
                <th>{trans.__('Comment')}</th>
                <th>{trans.__('Edit')}</th>
                <th>{trans.__('Manage')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(roleCapabilities).map(([role, capabilities]) => (
                <tr key={role}>
                  <td className="jp-PermissionsDialog-roleName">
                    {trans.__(role.charAt(0).toUpperCase() + role.slice(1))}
                  </td>
                  <td className="jp-PermissionsDialog-capability">
                    {capabilities.view ? '✓' : '✗'}
                  </td>
                  <td className="jp-PermissionsDialog-capability">
                    {capabilities.comment ? '✓' : '✗'}
                  </td>
                  <td className="jp-PermissionsDialog-capability">
                    {capabilities.edit ? '✓' : '✗'}
                  </td>
                  <td className="jp-PermissionsDialog-capability">
                    {capabilities.manage ? '✓' : '✗'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dialog footer */}
      <div className="jp-PermissionsDialog-footer">
        <button
          onClick={handleClose}
          className="jp-PermissionsDialog-cancelButton"
        >
          {trans.__('Cancel')}
        </button>
        <button
          onClick={handleSave}
          className="jp-PermissionsDialog-saveButton jp-mod-accept"
        >
          {trans.__('Save')}
        </button>
      </div>
    </Modal>
  );
};

/**
 * A namespace for PermissionsDialog static methods
 */
export namespace PermissionsDialog {
  /**
   * Create a new PermissionsDialog widget
   *
   * @param options - The dialog options
   */
  export const create = ({
    isOpen,
    onClose,
    permissionsService,
    translator,
    notebookPath,
    selectedCellId
  }: IPermissionsDialogProps): ReactWidget => {
    return ReactWidget.create(
      <PermissionsDialog
        isOpen={isOpen}
        onClose={onClose}
        permissionsService={permissionsService}
        translator={translator}
        notebookPath={notebookPath}
        selectedCellId={selectedCellId}
      />
    );
  };

  /**
   * Show a permissions dialog
   *
   * @param options - The dialog options
   * @returns The created widget
   */
  export const show = (options: IPermissionsDialogProps): ReactWidget => {
    const widget = create(options);
    widget.addClass('jp-PermissionsDialog-widget');
    return widget;
  };
}

/**
 * CSS classes for styling the permissions dialog
 */
export const PERMISSIONS_DIALOG_CLASS = 'jp-PermissionsDialog';
export const PERMISSIONS_DIALOG_HEADER_CLASS = 'jp-PermissionsDialog-header';
export const PERMISSIONS_DIALOG_CONTENT_CLASS = 'jp-PermissionsDialog-content';
export const PERMISSIONS_DIALOG_FOOTER_CLASS = 'jp-PermissionsDialog-footer';