// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { JupyterFrontEnd } from '@jupyterlab/application';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { find } from '@lumino/algorithm';
import { JSONExt, PromiseDelegate, Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import { 
  ICollaborationStatusManager, 
  ICollaborationAwareness 
} from './tokens';

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

/**
 * The Jupyter Notebook application shell token.
 */
export const INotebookShell = new Token<INotebookShell>(
  '@jupyter-notebook/application:INotebookShell'
);

/**
 * The Jupyter Notebook application shell interface.
 */
export interface INotebookShell extends NotebookShell {
  /**
   * Add a collaboration status bar widget to the shell.
   */
  addCollaborationStatusBar(widget: Widget, options?: DocumentRegistry.IOpenOptions): void;

  /**
   * Update the collaboration status information.
   */
  updateCollaborationStatus(status: INotebookShell.ICollaborationStatus): void;

  /**
   * Show collaboration disconnected state.
   */
  showCollaborationDisconnected(): void;

  /**
   * Add a user presence panel widget to the shell.
   */
  addPresencePanel(widget: Widget, options?: DocumentRegistry.IOpenOptions): void;

  /**
   * Update the presence indicators with current users.
   */
  updatePresenceIndicators(users: ReadonlyArray<ICollaborationAwareness.IUser>): void;

  /**
   * Show active users in the presence panel.
   */
  showActiveUsers(users: ReadonlyArray<ICollaborationAwareness.IUser>): void;

  /**
   * Check if collaboration features are enabled.
   */
  readonly isCollaborationEnabled: boolean;
}

/**
 * The namespace for INotebookShell type information.
 */
export namespace INotebookShell {
  /**
   * The areas of the application shell where widgets can reside.
   */
  export type Area = 'main' | 'top' | 'menu' | 'left' | 'right' | 'down' | 'collab-status' | 'collab-presence';

  /**
   * Widget position
   */
  export interface IWidgetPosition {
    /**
     * Widget area
     */
    area?: Area;
    /**
     * Widget opening options
     */
    options?: DocumentRegistry.IOpenOptions;
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
   * Collaboration status information interface.
   */
  export interface ICollaborationStatus {
    /**
     * Whether collaboration is enabled.
     */
    enabled: boolean;

    /**
     * Current connection status.
     */
    connectionStatus: ICollaborationStatusManager.ConnectionStatus;

    /**
     * Current user role.
     */
    userRole: ICollaborationStatusManager.UserRole;

    /**
     * Number of active users.
     */
    activeUserCount: number;
  }
}

/**
 * The default rank for ranked panels.
 */
const DEFAULT_RANK = 900;

/**
 * The application shell.
 */
export class NotebookShell extends Widget implements JupyterFrontEnd.IShell {
  constructor() {
    super();
    this.id = 'main';
    this._userLayout = {};

    this._topHandler = new PanelHandler();
    this._menuHandler = new PanelHandler();
    this._leftHandler = new SidePanelHandler('left');
    this._rightHandler = new SidePanelHandler('right');
    this._main = new Panel();

    // Initialize collaboration components
    this._collaborationStatusHandler = new PanelHandler();
    this._collaborationPresenceHandler = new PanelHandler();
    this._isCollaborationEnabled = this._checkCollaborationFeatureFlag();
    this._collaborationStatus = {
      enabled: this._isCollaborationEnabled,
      connectionStatus: ICollaborationStatusManager.ConnectionStatus.Disconnected,
      userRole: ICollaborationStatusManager.UserRole.Viewer,
      activeUserCount: 0
    };
    const topWrapper = (this._topWrapper = new Panel());
    const menuWrapper = (this._menuWrapper = new Panel());

    this._topHandler.panel.id = 'top-panel';
    this._topHandler.panel.node.setAttribute('role', 'banner');
    this._menuHandler.panel.id = 'menu-panel';
    this._menuHandler.panel.node.setAttribute('role', 'navigation');
    this._main.id = 'main-panel';
    this._main.node.setAttribute('role', 'main');

    // Setup collaboration panels
    this._collaborationStatusHandler.panel.id = 'collab-status-panel';
    this._collaborationStatusHandler.panel.node.setAttribute('role', 'status');
    this._collaborationStatusHandler.panel.addClass('jp-notebook-collaboration-status');
    
    this._collaborationPresenceHandler.panel.id = 'collab-presence-panel';
    this._collaborationPresenceHandler.panel.node.setAttribute('role', 'complementary');
    this._collaborationPresenceHandler.panel.addClass('jp-notebook-collaboration-presence');

    // Hide collaboration panels initially if collaboration is disabled
    if (!this._isCollaborationEnabled) {
      this._collaborationStatusHandler.panel.hide();
      this._collaborationPresenceHandler.panel.hide();
    }

    this._spacer_top = new Widget();
    this._spacer_top.id = 'spacer-widget-top';
    this._spacer_bottom = new Widget();
    this._spacer_bottom.id = 'spacer-widget-bottom';

    // create wrappers around the top and menu areas
    topWrapper.id = 'top-panel-wrapper';
    topWrapper.addWidget(this._topHandler.panel);
    
    // Add collaboration status bar to top wrapper if enabled
    if (this._isCollaborationEnabled) {
      topWrapper.addWidget(this._collaborationStatusHandler.panel);
    }

    menuWrapper.id = 'menu-panel-wrapper';
    menuWrapper.addWidget(this._menuHandler.panel);

    const rootLayout = new BoxLayout();
    const leftHandler = this._leftHandler;
    const rightHandler = this._rightHandler;

    leftHandler.panel.id = 'jp-left-stack';
    leftHandler.panel.node.setAttribute('role', 'complementary');
    rightHandler.panel.id = 'jp-right-stack';
    rightHandler.panel.node.setAttribute('role', 'complementary');

    // Add collaboration presence panel to right side if enabled
    if (this._isCollaborationEnabled) {
      rightHandler.addWidget(this._collaborationPresenceHandler.panel, 100);
    }

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
   * Check if collaboration features are enabled.
   */
  get isCollaborationEnabled(): boolean {
    return this._isCollaborationEnabled;
  }

  /**
   * Activate a widget in its area.
   */
  activateById(id: string): void {
    // Search all areas that can have widgets for this widget, starting with main.
    for (const area of ['main', 'top', 'left', 'right', 'menu', 'down', 'collab-status', 'collab-presence']) {
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
        } else if (area === 'collab-status' || area === 'collab-presence') {
          // Collaboration widgets are always visible when enabled
          widget.activate();
        } else {
          widget.activate();
        }
      }
    }
  }

  /**
   * Add a widget to the application shell.
   *
   * @param widget - The widget being added.
   *
   * @param area - Optional region in the shell into which the widget should
   * be added.
   *
   * @param options - Optional open options.
   *
   */
  add(
    widget: Widget,
    area?: INotebookShell.Area,
    options?: DocumentRegistry.IOpenOptions
  ): void {
    let userPosition: INotebookShell.IWidgetPosition | undefined;
    if (options?.type && this._userLayout[options.type]) {
      userPosition = this._userLayout[options.type];
    } else {
      userPosition = this._userLayout[widget.id];
    }

    area = userPosition?.area ?? area;
    options =
      options || userPosition?.options
        ? {
            ...options,
            ...userPosition?.options,
          }
        : undefined;

    const rank = options?.rank ?? DEFAULT_RANK;
    switch (area) {
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
      case 'collab-status':
        if (this._isCollaborationEnabled) {
          return this._collaborationStatusHandler.addWidget(widget, rank);
        } else {
          console.warn('Collaboration is not enabled');
          return;
        }
      case 'collab-presence':
        if (this._isCollaborationEnabled) {
          return this._collaborationPresenceHandler.addWidget(widget, rank);
        } else {
          console.warn('Collaboration is not enabled');
          return;
        }
      default:
        console.warn(`Cannot add widget to area: ${area}`);
    }
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
   * @param area The area
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
      case 'collab-status':
        yield* this._collaborationStatusHandler.panel.widgets;
        return;
      case 'collab-presence':
        yield* this._collaborationPresenceHandler.panel.widgets;
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
   * Add a collaboration status bar widget to the shell.
   */
  addCollaborationStatusBar(widget: Widget, options?: DocumentRegistry.IOpenOptions): void {
    if (!this._isCollaborationEnabled) {
      console.warn('Cannot add collaboration status bar: collaboration is not enabled');
      return;
    }
    
    const rank = options?.rank ?? DEFAULT_RANK;
    this._collaborationStatusHandler.addWidget(widget, rank);
    
    // Show the collaboration status handler panel if it was hidden
    this._collaborationStatusHandler.panel.show();
  }

  /**
   * Update the collaboration status information.
   */
  updateCollaborationStatus(status: INotebookShell.ICollaborationStatus): void {
    if (!this._isCollaborationEnabled) {
      return;
    }

    const previousStatus = { ...this._collaborationStatus };
    this._collaborationStatus = { ...status };

    // Update UI elements based on status changes
    if (previousStatus.connectionStatus !== status.connectionStatus) {
      this._updateConnectionStatusIndicators(status.connectionStatus);
    }

    if (previousStatus.userRole !== status.userRole) {
      this._updateUserRoleIndicators(status.userRole);
    }

    if (previousStatus.activeUserCount !== status.activeUserCount) {
      this._updateActiveUserCountIndicators(status.activeUserCount);
    }
  }

  /**
   * Show collaboration disconnected state.
   */
  showCollaborationDisconnected(): void {
    if (!this._isCollaborationEnabled) {
      return;
    }

    this.updateCollaborationStatus({
      enabled: true,
      connectionStatus: ICollaborationStatusManager.ConnectionStatus.Disconnected,
      userRole: this._collaborationStatus.userRole,
      activeUserCount: 0
    });

    // Add visual indicators for disconnected state
    this._collaborationStatusHandler.panel.addClass('jp-collaboration-disconnected');
    this._collaborationPresenceHandler.panel.addClass('jp-collaboration-disconnected');
  }

  /**
   * Add a user presence panel widget to the shell.
   */
  addPresencePanel(widget: Widget, options?: DocumentRegistry.IOpenOptions): void {
    if (!this._isCollaborationEnabled) {
      console.warn('Cannot add presence panel: collaboration is not enabled');
      return;
    }

    const rank = options?.rank ?? DEFAULT_RANK;
    this._collaborationPresenceHandler.addWidget(widget, rank);
    
    // Show the collaboration presence handler panel if it was hidden
    this._collaborationPresenceHandler.panel.show();
  }

  /**
   * Update the presence indicators with current users.
   */
  updatePresenceIndicators(users: ReadonlyArray<ICollaborationAwareness.IUser>): void {
    if (!this._isCollaborationEnabled) {
      return;
    }

    this._activeUsers = [...users];
    
    // Update the active user count in collaboration status
    this.updateCollaborationStatus({
      ...this._collaborationStatus,
      activeUserCount: users.length
    });

    // Notify widgets in the presence panel about user changes
    for (const widget of this._collaborationPresenceHandler.panel.widgets) {
      if (widget && 'updateUsers' in widget && typeof widget.updateUsers === 'function') {
        (widget as any).updateUsers(users);
      }
    }
  }

  /**
   * Show active users in the presence panel.
   */
  showActiveUsers(users: ReadonlyArray<ICollaborationAwareness.IUser>): void {
    if (!this._isCollaborationEnabled) {
      return;
    }

    this.updatePresenceIndicators(users);
    
    // Ensure presence panel is visible
    this._collaborationPresenceHandler.panel.show();
    this._collaborationPresenceHandler.panel.removeClass('jp-collaboration-disconnected');
  }

  /**
   * Handle a change on the down panel widgets
   */
  private _onTabPanelChanged(): void {
    if (this._downPanel.stackedPanel.widgets.length === 0) {
      this._downPanel.hide();
    }
  }

  /**
   * Check if collaboration feature flag is enabled.
   */
  private _checkCollaborationFeatureFlag(): boolean {
    // Check for collaboration feature flag in various ways
    // 1. Environment variable
    if (typeof process !== 'undefined' && process.env?.JUPYTER_COLLABORATION_ENABLED === 'true') {
      return true;
    }

    // 2. URL parameter
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('collaboration') === 'true') {
        return true;
      }
    }

    // 3. Local storage setting
    if (typeof localStorage !== 'undefined') {
      const storedSetting = localStorage.getItem('jupyter-notebook-collaboration-enabled');
      if (storedSetting === 'true') {
        return true;
      }
    }

    // 4. Check if collaboration CSS class is present on body (set by server)
    if (typeof document !== 'undefined') {
      const body = document.body;
      if (body && body.classList.contains('jp-collaboration-enabled')) {
        return true;
      }
    }

    // 5. Check for presence of collaboration server endpoint
    if (typeof fetch !== 'undefined') {
      // This will be checked asynchronously in real implementation
      // For now, return false as default
    }

    return false;
  }

  /**
   * Update connection status indicators in the UI.
   */
  private _updateConnectionStatusIndicators(status: ICollaborationStatusManager.ConnectionStatus): void {
    const statusPanel = this._collaborationStatusHandler.panel;
    const presencePanel = this._collaborationPresenceHandler.panel;

    // Remove all connection status classes
    statusPanel.removeClass('jp-collaboration-connecting');
    statusPanel.removeClass('jp-collaboration-connected');
    statusPanel.removeClass('jp-collaboration-disconnected');
    statusPanel.removeClass('jp-collaboration-error');

    presencePanel.removeClass('jp-collaboration-connecting');
    presencePanel.removeClass('jp-collaboration-connected');
    presencePanel.removeClass('jp-collaboration-disconnected');
    presencePanel.removeClass('jp-collaboration-error');

    // Add appropriate status class
    const statusClass = `jp-collaboration-${status}`;
    statusPanel.addClass(statusClass);
    presencePanel.addClass(statusClass);

    // Update status widgets
    for (const widget of statusPanel.widgets) {
      if (widget && 'updateConnectionStatus' in widget && typeof widget.updateConnectionStatus === 'function') {
        (widget as any).updateConnectionStatus(status);
      }
    }
  }

  /**
   * Update user role indicators in the UI.
   */
  private _updateUserRoleIndicators(role: ICollaborationStatusManager.UserRole): void {
    const statusPanel = this._collaborationStatusHandler.panel;

    // Remove all role classes
    statusPanel.removeClass('jp-collaboration-viewer');
    statusPanel.removeClass('jp-collaboration-editor');
    statusPanel.removeClass('jp-collaboration-admin');

    // Add appropriate role class
    const roleClass = `jp-collaboration-${role}`;
    statusPanel.addClass(roleClass);

    // Update status widgets
    for (const widget of statusPanel.widgets) {
      if (widget && 'updateUserRole' in widget && typeof widget.updateUserRole === 'function') {
        (widget as any).updateUserRole(role);
      }
    }
  }

  /**
   * Update active user count indicators in the UI.
   */
  private _updateActiveUserCountIndicators(count: number): void {
    // Update presence panel with user count
    const presencePanel = this._collaborationPresenceHandler.panel;
    presencePanel.dataset.userCount = count.toString();

    // Update presence widgets
    for (const widget of presencePanel.widgets) {
      if (widget && 'updateUserCount' in widget && typeof widget.updateUserCount === 'function') {
        (widget as any).updateUserCount(count);
      }
    }

    // Update status widgets
    for (const widget of this._collaborationStatusHandler.panel.widgets) {
      if (widget && 'updateActiveUserCount' in widget && typeof widget.updateActiveUserCount === 'function') {
        (widget as any).updateActiveUserCount(count);
      }
    }
  }

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

  // Collaboration-related properties
  private _collaborationStatusHandler: PanelHandler;
  private _collaborationPresenceHandler: PanelHandler;
  private _isCollaborationEnabled: boolean;
  private _collaborationStatus: INotebookShell.ICollaborationStatus;
  private _activeUsers: ReadonlyArray<ICollaborationAwareness.IUser> = [];
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
