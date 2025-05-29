// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { JupyterFrontEnd } from '@jupyterlab/application';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { find } from '@lumino/algorithm';
import { JSONExt, PromiseDelegate, Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import {
  BoxLayout,
  FocusTracker,
  Panel,
  SplitPanel,
  TabPanel,
  Widget,
} from '@lumino/widgets';
import { PanelHandler, SidePanelHandler } from './panelhandler';
import { TabPanelSvg } from '@jupyterlab/ui-components';

// Import collaboration interfaces and tokens
import {
  IYjsNotebookProvider,
  IAwarenessManager,
  ILockManager,
  IHistoryManager,
  IPermissionsManager,
  ICommentManager
} from './tokens';

/**
 * The Jupyter Notebook application shell token.
 */
export const INotebookShell = new Token<INotebookShell>(
  '@jupyter-notebook/application:INotebookShell'
);

/**
 * The Jupyter Notebook application shell interface.
 */
export interface INotebookShell extends NotebookShell {}

/**
 * The namespace for INotebookShell type information.
 */
export namespace INotebookShell {
  /**
   * The areas of the application shell where widgets can reside.
   * Enhanced to support collaboration namespaces per Section 7.2.1
   */
  export type Area = 
    | 'main' 
    | 'top' 
    | 'menu' 
    | 'left' 
    | 'right' 
    | 'down'
    | 'collaboration-top'      // Collaboration Bar in top area
    | 'collaboration-sidebar'  // History Viewer and Permissions Dialog in right sidebar
    | 'cell-overlay';          // Cell-level UI elements (comments, locks)

  /**
   * Widget position with enhanced collaboration options
   */
  export interface IWidgetPosition {
    /**
     * Widget area including collaboration namespaces
     */
    area?: Area;
    /**
     * Widget opening options
     */
    options?: DocumentRegistry.IOpenOptions;
    /**
     * Collaboration-specific positioning options
     */
    collaborationOptions?: ICollaborationOptions;
  }

  /**
   * Collaboration-specific options for widget positioning
   */
  export interface ICollaborationOptions {
    /**
     * Priority for collaboration widgets (higher numbers = higher priority)
     */
    priority?: number;
    /**
     * Whether this widget should be hidden when collaboration is disabled
     */
    collaborationOnly?: boolean;
    /**
     * Responsive breakpoints for the widget
     */
    responsive?: {
      hideOnMobile?: boolean;
      hideOnTablet?: boolean;
      compactMode?: boolean;
    };
    /**
     * Required permissions to display this widget
     */
    requiredPermissions?: string[];
  }

  /**
   * Mapping of widget type identifier and their user customized position
   */
  export interface IUserLayout {
    /**
     * Widget customized position
     */
    [k: string]: IWidgetPosition;
  }

  /**
   * Collaboration status information
   */
  export interface ICollaborationStatus {
    /**
     * Whether collaboration is enabled and active
     */
    isActive: boolean;
    /**
     * Connection status to collaboration server
     */
    connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error';
    /**
     * Number of active collaborators
     */
    collaboratorCount: number;
    /**
     * Current user's permissions
     */
    userPermissions: string[];
    /**
     * Whether real-time sync is working
     */
    syncStatus: 'synced' | 'syncing' | 'conflict' | 'offline';
    /**
     * Last sync timestamp
     */
    lastSyncTime?: number;
  }
}

/**
 * The default rank for ranked panels.
 */
const DEFAULT_RANK = 900;

/**
 * The default collaboration priority for collaboration widgets.
 */
const DEFAULT_COLLABORATION_PRIORITY = 500;

/**
 * The application shell with enhanced collaboration support.
 * 
 * Enhanced per Section 7.2.1 to support collaboration namespaces and
 * real-time document synchronization via YjsNotebookProvider integration.
 */
export class NotebookShell extends Widget implements JupyterFrontEnd.IShell {
  constructor() {
    super();
    this.id = 'main';
    this._userLayout = {};
    this._collaborationStatus = {
      isActive: false,
      connectionStatus: 'disconnected',
      collaboratorCount: 0,
      userPermissions: [],
      syncStatus: 'offline'
    };
    this._collaborationWidgets = new Map();

    this._topHandler = new PanelHandler();
    this._menuHandler = new PanelHandler();
    this._leftHandler = new SidePanelHandler('left');
    this._rightHandler = new SidePanelHandler('right');
    this._main = new Panel();
    
    // Create collaboration-specific panels per Section 7.2.1
    this._collaborationTopPanel = new Panel();
    this._collaborationSidebarPanel = new Panel();
    this._cellOverlayPanel = new Panel();
    
    const topWrapper = (this._topWrapper = new Panel());
    const menuWrapper = (this._menuWrapper = new Panel());

    this._topHandler.panel.id = 'top-panel';
    this._topHandler.panel.node.setAttribute('role', 'banner');
    this._menuHandler.panel.id = 'menu-panel';
    this._menuHandler.panel.node.setAttribute('role', 'navigation');
    this._main.id = 'main-panel';
    this._main.node.setAttribute('role', 'main');

    // Set up collaboration panels
    this._collaborationTopPanel.id = 'collaboration-top-panel';
    this._collaborationTopPanel.addClass('jp-collaboration-top');
    this._collaborationSidebarPanel.id = 'collaboration-sidebar-panel';
    this._collaborationSidebarPanel.addClass('jp-collaboration-sidebar');
    this._cellOverlayPanel.id = 'cell-overlay-panel';
    this._cellOverlayPanel.addClass('jp-cell-overlay');

    this._spacer_top = new Widget();
    this._spacer_top.id = 'spacer-widget-top';
    this._spacer_bottom = new Widget();
    this._spacer_bottom.id = 'spacer-widget-bottom';

    // create wrappers around the top and menu areas
    topWrapper.id = 'top-panel-wrapper';
    topWrapper.addWidget(this._topHandler.panel);
    // Add collaboration top panel to top wrapper per Section 7.2.1
    topWrapper.addWidget(this._collaborationTopPanel);

    menuWrapper.id = 'menu-panel-wrapper';
    menuWrapper.addWidget(this._menuHandler.panel);

    const rootLayout = new BoxLayout();
    const leftHandler = this._leftHandler;
    const rightHandler = this._rightHandler;

    leftHandler.panel.id = 'jp-left-stack';
    leftHandler.panel.node.setAttribute('role', 'complementary');
    rightHandler.panel.id = 'jp-right-stack';
    rightHandler.panel.node.setAttribute('role', 'complementary');
    
    // Add collaboration sidebar panel to right handler per Section 7.2.1
    rightHandler.panel.addWidget(this._collaborationSidebarPanel);

    // Hide the side panels by default.
    leftHandler.hide();
    rightHandler.hide();

    const middleLayout = new BoxLayout({
      spacing: 0,
      direction: 'top-to-bottom',
    });
    BoxLayout.setStretch(this._topWrapper, 0);
    BoxLayout.setStretch(this._menuWrapper, 0);
    BoxLayout.setStretch(this._main, 1);

    const middlePanel = new Panel({ layout: middleLayout });
    middlePanel.addWidget(this._topWrapper);
    middlePanel.addWidget(this._menuWrapper);
    middlePanel.addWidget(this._spacer_top);
    middlePanel.addWidget(this._main);
    middlePanel.addWidget(this._spacer_bottom);
    // Add cell overlay panel to middle panel for cell-level UI elements
    middlePanel.addWidget(this._cellOverlayPanel);
    middlePanel.layout = middleLayout;

    const vsplitPanel = new SplitPanel();
    vsplitPanel.id = 'jp-main-vsplit-panel';
    vsplitPanel.spacing = 1;
    vsplitPanel.orientation = 'vertical';
    SplitPanel.setStretch(vsplitPanel, 1);

    const downPanel = new TabPanelSvg({
      tabsMovable: true,
    });
    this._downPanel = downPanel;
    this._downPanel.id = 'jp-down-stack';

    // TODO: Consider storing this as an attribute this._hsplitPanel if saving/restoring layout needed
    const hsplitPanel = new SplitPanel();
    hsplitPanel.id = 'main-split-panel';
    hsplitPanel.spacing = 1;
    BoxLayout.setStretch(hsplitPanel, 1);

    SplitPanel.setStretch(leftHandler.panel, 0);
    SplitPanel.setStretch(rightHandler.panel, 0);
    SplitPanel.setStretch(middlePanel, 1);

    hsplitPanel.addWidget(leftHandler.panel);
    hsplitPanel.addWidget(middlePanel);
    hsplitPanel.addWidget(rightHandler.panel);

    // Use relative sizing to set the width of the side panels.
    // This will still respect the min-size of children widget in the stacked
    // panel.
    hsplitPanel.setRelativeSizes([1, 2.5, 1]);

    vsplitPanel.addWidget(hsplitPanel);
    vsplitPanel.addWidget(downPanel);

    rootLayout.spacing = 0;
    rootLayout.addWidget(vsplitPanel);

    // initially hiding the down panel
    this._downPanel.hide();

    // Connect down panel change listeners
    this._downPanel.tabBar.tabMoved.connect(this._onTabPanelChanged, this);
    this._downPanel.stackedPanel.widgetRemoved.connect(
      this._onTabPanelChanged,
      this
    );

    this.layout = rootLayout;

    // Added Skip to Main Link
    const skipLinkWidgetHandler = (this._skipLinkWidgetHandler =
      new Private.SkipLinkWidgetHandler(this));

    this.add(skipLinkWidgetHandler.skipLinkWidget, 'top', { rank: 0 });
    this._skipLinkWidgetHandler.show();

    // Initialize responsive layout adaptation per Section 7.3.4
    this._initializeResponsiveLayout();
  }

  /**
   * A signal emitted when the current widget changes.
   */
  get currentChanged(): ISignal<
    JupyterFrontEnd.IShell,
    FocusTracker.IChangedArgs<Widget>
  > {
    return this._currentChanged;
  }

  /**
   * The current widget in the shell's main area.
   */
  get currentWidget(): Widget | null {
    return this._main.widgets[0] ?? null;
  }

  /**
   * A signal emitted when collaboration status changes.
   */
  get collaborationStatusChanged(): ISignal<
    this,
    INotebookShell.ICollaborationStatus
  > {
    return this._collaborationStatusChanged;
  }

  /**
   * Get the current collaboration status.
   */
  get collaborationStatus(): INotebookShell.ICollaborationStatus {
    return { ...this._collaborationStatus };
  }

  /**
   * Get the top area wrapper panel
   */
  get top(): Widget {
    return this._topWrapper;
  }

  /**
   * Get the menu area wrapper panel
   */
  get menu(): Widget {
    return this._menuWrapper;
  }

  /**
   * Get the collaboration top panel
   */
  get collaborationTop(): Widget {
    return this._collaborationTopPanel;
  }

  /**
   * Get the collaboration sidebar panel
   */
  get collaborationSidebar(): Widget {
    return this._collaborationSidebarPanel;
  }

  /**
   * Get the cell overlay panel
   */
  get cellOverlay(): Widget {
    return this._cellOverlayPanel;
  }

  /**
   * Get the left area handler
   */
  get leftHandler(): SidePanelHandler {
    return this._leftHandler;
  }

  /**
   * Get the right area handler
   */
  get rightHandler(): SidePanelHandler {
    return this._rightHandler;
  }

  /**
   * Is the left sidebar visible?
   */
  get leftCollapsed(): boolean {
    return !(this._leftHandler.isVisible && this._leftHandler.panel.isVisible);
  }

  /**
   * Is the right sidebar visible?
   */
  get rightCollapsed(): boolean {
    return !(
      this._rightHandler.isVisible && this._rightHandler.panel.isVisible
    );
  }

  /**
   * Promise that resolves when the main widget is loaded
   */
  get restored(): Promise<void> {
    return this._mainWidgetLoaded.promise;
  }

  /**
   * Getter and setter for the translator.
   */
  get translator(): ITranslator {
    return this._translator ?? nullTranslator;
  }
  set translator(value: ITranslator) {
    if (value !== this._translator) {
      this._translator = value;
      const trans = value.load('notebook');
      this._leftHandler.closeButton.title = trans.__(
        'Collapse %1 side panel',
        this._leftHandler.area
      );
      this._rightHandler.closeButton.title = trans.__(
        'Collapse %1 side panel',
        this._rightHandler.area
      );
    }
  }

  /**
   * User custom shell layout.
   */
  get userLayout() {
    return JSONExt.deepCopy(this._userLayout as any);
  }

  /**
   * Set collaboration services for real-time synchronization.
   * Integrates with YjsNotebookProvider and collaboration modules per Section 5.2.1
   */
  setCollaborationServices(services: {
    yjsProvider?: IYjsNotebookProvider;
    awarenessManager?: IAwarenessManager;
    lockManager?: ILockManager;
    historyManager?: IHistoryManager;
    permissionsManager?: IPermissionsManager;
    commentManager?: ICommentManager;
  }): void {
    this._collaborationServices = services;

    // Connect to collaboration status updates
    if (services.yjsProvider) {
      // Monitor connection status
      this._updateCollaborationStatus({
        isActive: true,
        connectionStatus: services.yjsProvider.isConnected ? 'connected' : 'disconnected'
      });
    }

    if (services.awarenessManager) {
      // Monitor collaborator count
      services.awarenessManager.onAwarenessChange((users) => {
        this._updateCollaborationStatus({
          collaboratorCount: users.size
        });
      });
    }

    if (services.permissionsManager) {
      // Monitor user permissions
      services.permissionsManager.onPermissionChange((event) => {
        // Update user permissions based on current user
        this._updateCollaborationStatus({
          userPermissions: this._getCurrentUserPermissions()
        });
      });
    }
  }

  /**
   * Update collaboration status and emit signal.
   */
  private _updateCollaborationStatus(
    updates: Partial<INotebookShell.ICollaborationStatus>
  ): void {
    const previousStatus = { ...this._collaborationStatus };
    Object.assign(this._collaborationStatus, updates);
    
    // Update last sync time if status changed to synced
    if (updates.syncStatus === 'synced') {
      this._collaborationStatus.lastSyncTime = Date.now();
    }

    this._collaborationStatusChanged.emit(this._collaborationStatus);

    // Update UI based on collaboration status
    this._updateCollaborationUI(previousStatus);
  }

  /**
   * Update collaboration UI elements based on status changes.
   */
  private _updateCollaborationUI(
    previousStatus: INotebookShell.ICollaborationStatus
  ): void {
    const current = this._collaborationStatus;
    
    // Show/hide collaboration panels based on active status
    if (current.isActive !== previousStatus.isActive) {
      this._toggleCollaborationPanels(current.isActive);
    }

    // Update collaboration widgets visibility based on permissions
    if (current.userPermissions !== previousStatus.userPermissions) {
      this._updateCollaborationWidgetVisibility();
    }

    // Add visual indicators for connection status
    this.node.classList.toggle('jp-collaboration-active', current.isActive);
    this.node.classList.toggle('jp-collaboration-connected', 
      current.connectionStatus === 'connected');
    this.node.classList.toggle('jp-collaboration-syncing', 
      current.syncStatus === 'syncing');
    this.node.classList.toggle('jp-collaboration-conflict', 
      current.syncStatus === 'conflict');
  }

  /**
   * Toggle visibility of collaboration panels.
   */
  private _toggleCollaborationPanels(isActive: boolean): void {
    this._collaborationTopPanel.setHidden(!isActive);
    this._collaborationSidebarPanel.setHidden(!isActive);
    
    // Only show cell overlay if collaboration is active and user has permissions
    const hasWritePermission = this._collaborationStatus.userPermissions.includes('write');
    this._cellOverlayPanel.setHidden(!isActive || !hasWritePermission);
  }

  /**
   * Update visibility of collaboration widgets based on permissions.
   */
  private _updateCollaborationWidgetVisibility(): void {
    const userPermissions = this._collaborationStatus.userPermissions;
    
    this._collaborationWidgets.forEach((options, widget) => {
      if (options.requiredPermissions) {
        const hasRequiredPermissions = options.requiredPermissions.every(
          permission => userPermissions.includes(permission)
        );
        widget.setHidden(!hasRequiredPermissions);
      }
    });
  }

  /**
   * Get current user permissions from collaboration services.
   */
  private _getCurrentUserPermissions(): string[] {
    if (!this._collaborationServices?.permissionsManager) {
      return [];
    }
    
    // This would normally get the current user ID from the authentication system
    const currentUserId = 'current-user'; // Placeholder
    const userPermissions = this._collaborationServices.permissionsManager
      .getUserPermissions(currentUserId);
    
    return userPermissions.permissions || [];
  }

  /**
   * Initialize responsive layout adaptation per Section 7.3.4
   */
  private _initializeResponsiveLayout(): void {
    // Add responsive classes for CSS media queries
    this.node.classList.add('jp-NotebookShell-responsive');
    
    // Monitor window resize for responsive adaptations
    window.addEventListener('resize', () => {
      this._handleResponsiveLayout();
    });

    // Initial responsive layout setup
    this._handleResponsiveLayout();
  }

  /**
   * Handle responsive layout changes per Section 7.3.4
   */
  private _handleResponsiveLayout(): void {
    const width = window.innerWidth;
    const isMobile = width < 768;
    const isTablet = width >= 768 && width < 1024;
    
    // Update CSS classes for responsive behavior
    this.node.classList.toggle('jp-NotebookShell-mobile', isMobile);
    this.node.classList.toggle('jp-NotebookShell-tablet', isTablet);
    this.node.classList.toggle('jp-NotebookShell-desktop', width >= 1024);
    
    // Handle collaboration widget responsive behavior
    this._collaborationWidgets.forEach((options, widget) => {
      if (options.responsive) {
        const shouldHide = (isMobile && options.responsive.hideOnMobile) ||
                          (isTablet && options.responsive.hideOnTablet);
        
        if (shouldHide) {
          widget.setHidden(true);
        } else if (options.responsive.compactMode && (isMobile || isTablet)) {
          widget.addClass('jp-collaboration-compact');
        } else {
          widget.removeClass('jp-collaboration-compact');
          // Only show if collaboration is active and permissions allow
          const shouldShow = this._collaborationStatus.isActive &&
            (!options.requiredPermissions || 
             options.requiredPermissions.every(p => 
               this._collaborationStatus.userPermissions.includes(p)
             ));
          widget.setHidden(!shouldShow);
        }
      }
    });
  }

  /**
   * Activate a widget in its area.
   */
  activateById(id: string): void {
    // Search all areas that can have widgets for this widget, starting with main.
    for (const area of ['main', 'top', 'left', 'right', 'menu', 'down', 
                       'collaboration-top', 'collaboration-sidebar', 'cell-overlay']) {
      const widget = find(
        this.widgets(area as INotebookShell.Area),
        (w) => w.id === id
      );
      if (widget) {
        if (area === 'left') {
          this.expandLeft(id);
        } else if (area === 'right') {
          this.expandRight(id);
        } else if (area === 'down') {
          this._downPanel.show();
          widget.activate();
        } else if (area === 'collaboration-sidebar') {
          // Ensure right sidebar is visible for collaboration sidebar widgets
          this.expandRight();
          widget.activate();
        } else {
          widget.activate();
        }
      }
    }
  }

  /**
   * Add a widget to the application shell with enhanced collaboration support.
   *
   * @param widget - The widget being added.
   *
   * @param area - Optional region in the shell into which the widget should
   * be added, including collaboration namespaces.
   *
   * @param options - Optional open options with collaboration enhancements.
   *
   */
  add(
    widget: Widget,
    area?: INotebookShell.Area,
    options?: DocumentRegistry.IOpenOptions & {
      collaborationOptions?: INotebookShell.ICollaborationOptions;
    }
  ): void {
    let userPosition: INotebookShell.IWidgetPosition | undefined;
    if (options?.type && this._userLayout[options.type]) {
      userPosition = this._userLayout[options.type];
    } else {
      userPosition = this._userLayout[widget.id];
    }

    area = userPosition?.area ?? area;
    const collaborationOptions = options?.collaborationOptions || 
                                userPosition?.collaborationOptions;
    
    options =
      options || userPosition?.options
        ? {
            ...options,
            ...userPosition?.options,
          }
        : undefined;

    // Store collaboration options for the widget
    if (collaborationOptions) {
      this._collaborationWidgets.set(widget, collaborationOptions);
    }

    const rank = options?.rank ?? 
                 collaborationOptions?.priority ?? 
                 DEFAULT_RANK;

    // Handle collaboration-specific areas per Section 7.2.1
    switch (area) {
      case 'collaboration-top':
        this._addToCollaborationTop(widget, rank, collaborationOptions);
        break;
      case 'collaboration-sidebar':
        this._addToCollaborationSidebar(widget, rank, collaborationOptions);
        break;
      case 'cell-overlay':
        this._addToCellOverlay(widget, rank, collaborationOptions);
        break;
      case 'top':
        return this._topHandler.addWidget(widget, rank);
      case 'menu':
        return this._menuHandler.addWidget(widget, rank);
      case 'main':
      case undefined: {
        if (this._main.widgets.length > 0) {
          // do not add the widget if there is already one
          return;
        }
        const previousWidget = this.currentWidget;
        this._main.addWidget(widget);
        this._main.update();
        this._currentChanged.emit({
          newValue: widget,
          oldValue: previousWidget,
        });
        this._mainWidgetLoaded.resolve();
        break;
      }
      case 'left':
        return this._leftHandler.addWidget(widget, rank);
      case 'right':
        return this._rightHandler.addWidget(widget, rank);
      case 'down':
        return this._downPanel.addWidget(widget);
      default:
        console.warn(`Cannot add widget to area: ${area}`);
    }

    // Apply responsive layout settings if specified
    if (collaborationOptions?.responsive) {
      this._handleResponsiveLayout();
    }

    // Hide widget if collaboration is disabled and it's collaboration-only
    if (collaborationOptions?.collaborationOnly && !this._collaborationStatus.isActive) {
      widget.setHidden(true);
    }

    // Check permissions if required
    if (collaborationOptions?.requiredPermissions) {
      const hasPermissions = collaborationOptions.requiredPermissions.every(
        permission => this._collaborationStatus.userPermissions.includes(permission)
      );
      if (!hasPermissions) {
        widget.setHidden(true);
      }
    }
  }

  /**
   * Add widget to collaboration top area.
   */
  private _addToCollaborationTop(
    widget: Widget, 
    rank: number, 
    options?: INotebookShell.ICollaborationOptions
  ): void {
    // Add to collaboration top panel with priority-based ordering
    const widgets = Array.from(this._collaborationTopPanel.widgets);
    let insertIndex = widgets.length;
    
    // Find correct position based on rank/priority
    for (let i = 0; i < widgets.length; i++) {
      const otherWidget = widgets[i];
      const otherOptions = this._collaborationWidgets.get(otherWidget);
      const otherRank = otherOptions?.priority ?? DEFAULT_COLLABORATION_PRIORITY;
      
      if (rank < otherRank) {
        insertIndex = i;
        break;
      }
    }
    
    this._collaborationTopPanel.insertWidget(insertIndex, widget);
    widget.addClass('jp-collaboration-top-widget');
  }

  /**
   * Add widget to collaboration sidebar area.
   */
  private _addToCollaborationSidebar(
    widget: Widget, 
    rank: number, 
    options?: INotebookShell.ICollaborationOptions
  ): void {
    // Add to collaboration sidebar panel
    const widgets = Array.from(this._collaborationSidebarPanel.widgets);
    let insertIndex = widgets.length;
    
    // Find correct position based on rank/priority
    for (let i = 0; i < widgets.length; i++) {
      const otherWidget = widgets[i];
      const otherOptions = this._collaborationWidgets.get(otherWidget);
      const otherRank = otherOptions?.priority ?? DEFAULT_COLLABORATION_PRIORITY;
      
      if (rank < otherRank) {
        insertIndex = i;
        break;
      }
    }
    
    this._collaborationSidebarPanel.insertWidget(insertIndex, widget);
    widget.addClass('jp-collaboration-sidebar-widget');
    
    // Ensure right sidebar is visible when collaboration widgets are added
    if (this._collaborationStatus.isActive) {
      this.expandRight();
    }
  }

  /**
   * Add widget to cell overlay area.
   */
  private _addToCellOverlay(
    widget: Widget, 
    rank: number, 
    options?: INotebookShell.ICollaborationOptions
  ): void {
    // Cell overlay widgets are typically positioned absolutely within cells
    this._cellOverlayPanel.addWidget(widget);
    widget.addClass('jp-cell-overlay-widget');
    
    // Apply special positioning for cell overlay widgets
    widget.node.style.position = 'absolute';
    widget.node.style.zIndex = '1000';
    widget.node.style.pointerEvents = 'auto';
  }

  /**
   * Collapse the top area and the spacer to make the view more compact.
   */
  collapseTop(): void {
    this._topWrapper.setHidden(true);
    this._spacer_top.setHidden(true);
  }

  /**
   * Expand the top area to show the header and the spacer.
   */
  expandTop(): void {
    this._topWrapper.setHidden(false);
    this._spacer_top.setHidden(false);
  }

  /**
   * Return the list of widgets for the given area.
   *
   * @param area The area including collaboration namespaces
   */
  *widgets(area: INotebookShell.Area): IterableIterator<Widget> {
    switch (area ?? 'main') {
      case 'top':
        yield* this._topHandler.panel.widgets;
        return;
      case 'menu':
        yield* this._menuHandler.panel.widgets;
        return;
      case 'main':
        yield* this._main.widgets;
        return;
      case 'left':
        yield* this._leftHandler.widgets;
        return;
      case 'right':
        yield* this._rightHandler.widgets;
        return;
      case 'down':
        yield* this._downPanel.widgets;
        return;
      case 'collaboration-top':
        yield* this._collaborationTopPanel.widgets;
        return;
      case 'collaboration-sidebar':
        yield* this._collaborationSidebarPanel.widgets;
        return;
      case 'cell-overlay':
        yield* this._cellOverlayPanel.widgets;
        return;
      default:
        console.error(`This shell has no area called "${area}"`);
        return;
    }
  }

  /**
   * Expand the left panel to show the sidebar with its widget.
   */
  expandLeft(id?: string): void {
    this._leftHandler.panel.show();
    this._leftHandler.expand(id); // Show the current widget, if any
  }

  /**
   * Collapse the left panel
   */
  collapseLeft(): void {
    this._leftHandler.collapse();
    this._leftHandler.panel.hide();
  }

  /**
   * Expand the right panel to show the sidebar with its widget.
   */
  expandRight(id?: string): void {
    this._rightHandler.panel.show();
    this._rightHandler.expand(id); // Show the current widget, if any
  }

  /**
   * Collapse the right panel
   */
  collapseRight(): void {
    this._rightHandler.collapse();
    this._rightHandler.panel.hide();
  }

  /**
   * Restore the layout state and configuration for the application shell.
   */
  async restoreLayout(
    configuration: INotebookShell.IUserLayout
  ): Promise<void> {
    this._userLayout = configuration;
  }

  /**
   * Handle a change on the down panel widgets
   */
  private _onTabPanelChanged(): void {
    if (this._downPanel.stackedPanel.widgets.length === 0) {
      this._downPanel.hide();
    }
  }

  // Private members for collaboration support
  private _collaborationStatus: INotebookShell.ICollaborationStatus;
  private _collaborationServices?: {
    yjsProvider?: IYjsNotebookProvider;
    awarenessManager?: IAwarenessManager;
    lockManager?: ILockManager;
    historyManager?: IHistoryManager;
    permissionsManager?: IPermissionsManager;
    commentManager?: ICommentManager;
  };
  private _collaborationWidgets = new Map<Widget, INotebookShell.ICollaborationOptions>();
  private _collaborationStatusChanged = new Signal<
    this,
    INotebookShell.ICollaborationStatus
  >(this);

  // Collaboration panels per Section 7.2.1
  private _collaborationTopPanel: Panel;
  private _collaborationSidebarPanel: Panel;
  private _cellOverlayPanel: Panel;

  // Existing private members
  private _topWrapper: Panel;
  private _topHandler: PanelHandler;
  private _menuWrapper: Panel;
  private _menuHandler: PanelHandler;
  private _leftHandler: SidePanelHandler;
  private _rightHandler: SidePanelHandler;
  private _spacer_top: Widget;
  private _spacer_bottom: Widget;
  private _skipLinkWidgetHandler: Private.SkipLinkWidgetHandler;
  private _main: Panel;
  private _downPanel: TabPanel;
  private _translator: ITranslator = nullTranslator;
  private _currentChanged = new Signal<this, FocusTracker.IChangedArgs<Widget>>(
    this
  );
  private _mainWidgetLoaded = new PromiseDelegate<void>();
  private _userLayout: INotebookShell.IUserLayout;
}

export namespace Private {
  export class SkipLinkWidgetHandler {
    /**
     * Construct a new skipLink widget handler.
     */
    constructor(shell: INotebookShell) {
      const skipLinkWidget = (this._skipLinkWidget = new Widget());
      const skipToMain = document.createElement('a');
      skipToMain.href = '#first-cell';
      skipToMain.tabIndex = 1;
      skipToMain.text = 'Skip to Main';
      skipToMain.className = 'skip-link';
      skipToMain.addEventListener('click', this);
      skipLinkWidget.addClass('jp-skiplink');
      skipLinkWidget.id = 'jp-skiplink';
      skipLinkWidget.node.appendChild(skipToMain);
    }

    handleEvent(event: Event): void {
      switch (event.type) {
        case 'click':
          this._focusMain();
          break;
      }
    }

    private _focusMain() {
      const input = document.querySelector(
        '#main-panel .jp-InputArea-editor'
      ) as HTMLInputElement;
      input.tabIndex = 1;
      input.focus();
    }

    /**
     * Get the input element managed by the handler.
     */
    get skipLinkWidget(): Widget {
      return this._skipLinkWidget;
    }

    /**
     * Dispose of the handler and the resources it holds.
     */
    dispose(): void {
      if (this.isDisposed) {
        return;
      }
      this._isDisposed = true;
      this._skipLinkWidget.node.removeEventListener('click', this);
      this._skipLinkWidget.dispose();
    }

    /**
     * Hide the skipLink widget.
     */
    hide(): void {
      this._skipLinkWidget.hide();
    }

    /**
     * Show the skipLink widget.
     */
    show(): void {
      this._skipLinkWidget.show();
    }

    /**
     * Test whether the handler has been disposed.
     */
    get isDisposed(): boolean {
      return this._isDisposed;
    }

    private _skipLinkWidget: Widget;
    private _isDisposed = false;
  }
}