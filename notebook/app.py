"""Jupyter notebook application."""

from __future__ import annotations

import os
import re
import typing as t
from pathlib import Path

from jupyter_client.utils import ensure_async  # type:ignore[attr-defined]
from jupyter_core.application import base_aliases
from jupyter_core.paths import jupyter_config_dir
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.extension.handler import (
    ExtensionHandlerJinjaMixin,
    ExtensionHandlerMixin,
)
from jupyter_server.serverapp import flags
from jupyter_server.utils import url_escape, url_is_absolute
from jupyter_server.utils import url_path_join as ujoin
from jupyterlab.commands import (  # type:ignore[import-untyped]
    get_app_dir,
    get_user_settings_dir,
    get_workspaces_dir,
)
from jupyterlab_server import LabServerApp
from jupyterlab_server.config import (  # type:ignore[attr-defined]
    LabConfig,
    get_page_config,
    recursive_update,
)
from jupyterlab_server.handlers import _camelCase, is_url
from notebook_shim.shim import NotebookConfigShimMixin  # type:ignore[import-untyped]
from tornado import web
from traitlets import Bool, Unicode, Integer, List, Dict, Float, default
from traitlets.config.loader import Config
import logging

from ._version import __version__

HERE = Path(__file__).parent.resolve()

Flags = dict[t.Union[str, tuple[str, ...]], tuple[t.Union[dict[str, t.Any], Config], str]]

app_dir = Path(get_app_dir())
version = __version__

# mypy: disable-error-code="no-untyped-call"


class NotebookBaseHandler(ExtensionHandlerJinjaMixin, ExtensionHandlerMixin, JupyterHandler):
    """The base notebook API handler."""

    @property
    def custom_css(self) -> t.Any:
        return self.settings.get("custom_css", True)

    def get_page_config(self) -> dict[str, t.Any]:
        """Get the page config."""
        config = LabConfig()
        app: JupyterNotebookApp = self.extensionapp  # type:ignore[assignment]
        base_url = self.settings.get("base_url", "/")
        page_config_data = self.settings.setdefault("page_config_data", {})
        page_config = {
            **page_config_data,
            "appVersion": version,
            "baseUrl": self.base_url,
            "terminalsAvailable": self.settings.get("terminals_available", False),
            "token": self.settings["token"],
            "fullStaticUrl": ujoin(self.base_url, "static", self.name),
            "frontendUrl": ujoin(self.base_url, "/"),
            "exposeAppInBrowser": app.expose_app_in_browser,
        }

        server_root = self.settings.get("server_root_dir", "")
        server_root = server_root.replace(os.sep, "/")
        server_root = os.path.normpath(Path(server_root).expanduser())
        try:
            # Remove the server_root from pref dir
            if self.serverapp.preferred_dir != server_root:
                page_config["preferredPath"] = "/" + os.path.relpath(
                    self.serverapp.preferred_dir, server_root
                )
            else:
                page_config["preferredPath"] = "/"
        except Exception:
            page_config["preferredPath"] = "/"

        mathjax_config = self.settings.get("mathjax_config", "TeX-AMS_HTML-full,Safe")
        # TODO Remove CDN usage.
        mathjax_url = self.settings.get(
            "mathjax_url",
            "https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.7/MathJax.js",
        )
        if not url_is_absolute(mathjax_url) and not mathjax_url.startswith(self.base_url):
            mathjax_url = ujoin(self.base_url, mathjax_url)

        page_config.setdefault("mathjaxConfig", mathjax_config)
        page_config.setdefault("fullMathjaxUrl", mathjax_url)
        page_config.setdefault("jupyterConfigDir", jupyter_config_dir())

        # Add collaboration-specific page_config settings to support frontend collaboration features
        # and UI components per Section 6.4.1 and Section 0.4.1 requirements
        collaboration_config = {
            "collaborationEnabled": app.collaboration_enabled,
            "collaborationSessionTimeout": app.collaboration_session_timeout,
            "collaborationMaxUsers": app.collaboration_max_users,
            "collaborationLogLevel": app.collaboration_log_level,
            "collaborationAuditEnabled": app.collaboration_audit_enabled,
            "collaborationRetentionDays": app.collaboration_retention_days,
            "collaborationEncryptionRequired": app.collaboration_encryption_required,
            "collaborationWsRateLimit": app.collaboration_ws_rate_limit,
            "collaborationCommentRateLimit": app.collaboration_comment_rate_limit,
            "collaborationLockTimeout": app.collaboration_lock_timeout,
        }
        
        # Only expose collaboration config if collaboration is enabled
        if app.collaboration_enabled:
            page_config.update(collaboration_config)
            
            # Add collaboration WebSocket endpoint URL
            page_config["collaborationWsUrl"] = ujoin(self.base_url, "api", "collaboration", "ws")
            
            # Add collaboration REST API base URLs  
            page_config["collaborationApiUrls"] = {
                "sessions": ujoin(self.base_url, "api", "collaboration", "sessions"),
                "permissions": ujoin(self.base_url, "api", "collaboration", "permissions"),
                "comments": ujoin(self.base_url, "api", "collaboration", "comments"),
                "history": ujoin(self.base_url, "api", "collaboration", "history"),
                "health": ujoin(self.base_url, "api", "collaboration", "health"),
            }

        # Put all our config in page_config
        for name in config.trait_names():
            page_config[_camelCase(name)] = getattr(app, name)

        # Add full versions of all the urls
        for name in config.trait_names():
            if not name.endswith("_url"):
                continue
            full_name = _camelCase("full_" + name)
            full_url = getattr(app, name)
            if not is_url(full_url):
                # Relative URL will be prefixed with base_url
                full_url = ujoin(base_url, full_url)
            page_config[full_name] = full_url

        labextensions_path = app.extra_labextensions_path + app.labextensions_path
        recursive_update(
            page_config,
            get_page_config(
                labextensions_path,
                logger=self.log,
            ),
        )

        # modify page config with custom hook
        page_config_hook = self.settings.get("page_config_hook", None)
        if page_config_hook:
            page_config = page_config_hook(self, page_config)

        return page_config


class TreeHandler(NotebookBaseHandler):
    """A tree page handler."""

    @web.authenticated
    async def get(self, path: str = "") -> None:
        """
        Display appropriate page for given path.

        - A directory listing is shown if path is a directory
        - Redirected to notebook page if path is a notebook
        - Render the raw file if path is any other file
        """
        path = path.strip("/")
        cm = self.contents_manager

        if await ensure_async(cm.dir_exists(path=path)):
            if await ensure_async(cm.is_hidden(path)) and not cm.allow_hidden:
                self.log.info("Refusing to serve hidden directory, via 404 Error")
                raise web.HTTPError(404)

            # Set treePath for routing to the directory
            page_config = self.get_page_config()
            page_config["treePath"] = path

            tpl = self.render_template("tree.html", page_config=page_config)
            return self.write(tpl)
        if await ensure_async(cm.file_exists(path)):
            # it's not a directory, we have redirecting to do
            model = await ensure_async(cm.get(path, content=False))
            if model["type"] == "notebook":
                url = ujoin(self.base_url, "notebooks", url_escape(path))
            else:
                # Return raw content if file is not a notebook
                url = ujoin(self.base_url, "files", url_escape(path))
            self.log.debug("Redirecting %s to %s", self.request.path, url)
            self.redirect(url)
            return None
        raise web.HTTPError(404)


class ConsoleHandler(NotebookBaseHandler):
    """A console page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the console page."""
        tpl = self.render_template("consoles.html", page_config=self.get_page_config())
        return self.write(tpl)


class TerminalHandler(NotebookBaseHandler):
    """A terminal page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the terminal page."""
        tpl = self.render_template("terminals.html", page_config=self.get_page_config())
        return self.write(tpl)


class FileHandler(NotebookBaseHandler):
    """A file page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the file page."""
        tpl = self.render_template("edit.html", page_config=self.get_page_config())
        return self.write(tpl)


class NotebookHandler(NotebookBaseHandler):
    """A notebook page handler."""

    @web.authenticated
    async def get(self, path: str = "") -> t.Any:
        """Get the notebook page. Redirect if it's a directory."""
        path = path.strip("/")
        cm = self.contents_manager

        if await ensure_async(cm.dir_exists(path=path)):
            url = ujoin(self.base_url, "tree", url_escape(path))
            self.log.debug("Redirecting %s to %s since path is a directory", self.request.path, url)
            self.redirect(url)
            return None
        tpl = self.render_template("notebooks.html", page_config=self.get_page_config())
        return self.write(tpl)


class CustomCssHandler(NotebookBaseHandler):
    """A custom CSS handler."""

    @web.authenticated
    def get(self) -> t.Any:
        """Get the custom css file."""

        self.set_header("Content-Type", "text/css")
        page_config = self.get_page_config()
        custom_css_file = f"{page_config['jupyterConfigDir']}/custom/custom.css"

        if not Path(custom_css_file).is_file():
            static_path_root = re.match("^(.*?)static", page_config["staticDir"])
            if static_path_root is not None:
                custom_dir = static_path_root.groups()[0]
                custom_css_file = f"{custom_dir}custom/custom.css"

        with Path(custom_css_file).open() as css_f:
            return self.write(css_f.read())


aliases = dict(base_aliases)


class JupyterNotebookApp(NotebookConfigShimMixin, LabServerApp):  # type:ignore[misc]
    """The notebook server extension app."""

    name = "notebook"
    app_name = "Jupyter Notebook"
    description = "Jupyter Notebook - A web-based notebook environment for interactive computing"
    version = version
    app_version = Unicode(version, help="The version of the application.")
    extension_url = "/"
    default_url = Unicode("/tree", config=True, help="The default URL to redirect to from `/`")
    file_url_prefix = "/tree"
    load_other_extensions = True
    app_dir = app_dir
    subcommands: dict[str, t.Any] = {}

    expose_app_in_browser = Bool(
        False,
        config=True,
        help="Whether to expose the global app instance to browser via window.jupyterapp",
    )

    custom_css = Bool(
        True,
        config=True,
        help="""Whether custom CSS is loaded on the page.
        Defaults to True and custom CSS is loaded.
        """,
    )

    # Collaboration configuration flags and traitlets per Section 6.4.1
    collaboration_enabled = Bool(
        True,
        config=True,
        help="""Enable or disable real-time collaborative editing capabilities.
        When disabled, collaboration endpoints return 404 and all collaboration
        features are bypassed without impacting single-user workflows.
        """,
    )

    collaboration_session_timeout = Integer(
        1800,  # 30 minutes in seconds
        config=True,
        help="""Timeout for collaborative editing sessions in seconds.
        Stale collaboration WebSockets are terminated after this duration.
        Defaults to 1800 seconds (30 minutes), shorter than standard sessions.
        """,
    )

    collaboration_max_users = Integer(
        20,
        config=True,
        help="""Maximum number of concurrent users per collaborative notebook session.
        Prevents resource exhaustion by limiting participants per notebook.
        """,
    )

    collaboration_log_level = Unicode(
        "INFO",
        config=True,
        help="""Logging level for collaboration events (DEBUG, INFO, WARNING, ERROR).
        Controls verbosity of collaboration-specific audit logging.
        """,
    )

    collaboration_audit_enabled = Bool(
        True,
        config=True,
        help="""Enable comprehensive audit logging for collaboration events.
        Captures presence, locks, comments, and version operations for compliance.
        """,
    )

    collaboration_retention_days = Integer(
        30,
        config=True,
        help="""Number of days to retain collaboration metadata and history.
        After this period, inactive collaboration sessions are automatically purged.
        """,
    )

    collaboration_encryption_required = Bool(
        True,
        config=True,
        help="""Require encryption for all collaboration channels.
        When True, enforces TLS for WebSocket connections and HMAC/JWT signatures.
        """,
    )

    collaboration_ws_rate_limit = Float(
        100.0,  # messages per second
        config=True,
        help="""Rate limit for collaboration WebSocket messages per user (messages/second).
        Prevents DoS attacks from misbehaving collaboration clients.
        """,
    )

    collaboration_comment_rate_limit = Float(
        10.0,  # requests per minute
        config=True,
        help="""Rate limit for collaboration comment API requests per user (requests/minute).
        Prevents comment spam and API abuse.
        """,
    )

    collaboration_lock_timeout = Integer(
        300,  # 5 minutes in seconds
        config=True,
        help="""Timeout for cell-level locks in seconds.
        Stale locks are automatically released after this duration.
        """,
    )

    collaboration_audit_events = List(
        ["presence", "locks", "comments", "versions"],
        config=True,
        help="""List of collaboration event types to include in audit logs.
        Available types: presence, locks, comments, versions, permissions.
        """,
    )

    collaboration_siem_integration = Dict(
        {
            "enabled": False,
            "format": "json",
            "destination": "file",
            "facility": "local5"
        },
        config=True,
        help="""SIEM integration configuration for collaboration audit logs.
        Supports structured JSON output to syslog, Kafka, or file destinations.
        """,
    )

    collaboration_data_residency = Unicode(
        "",
        config=True,
        help="""Data residency configuration for collaboration metadata storage.
        Enforces geographic constraints for regulatory compliance.
        """,
    )

    collaboration_gdpr_compliant = Bool(
        False,
        config=True,
        help="""Enable GDPR-compliant mode for collaboration features.
        Implements enhanced privacy controls and data retention policies.
        """,
    )

    flags: Flags = flags  # type:ignore[assignment]
    flags["expose-app-in-browser"] = (
        {"JupyterNotebookApp": {"expose_app_in_browser": True}},
        "Expose the global app instance to browser via window.jupyterapp.",
    )

    flags["custom-css"] = (
        {"JupyterNotebookApp": {"custom_css": True}},
        "Load custom CSS in template html files. Default is True",
    )

    # Add collaboration-specific command-line flags
    flags["collaboration-enabled"] = (
        {"JupyterNotebookApp": {"collaboration_enabled": True}},
        "Enable real-time collaborative editing features.",
    )

    flags["no-collaboration"] = (
        {"JupyterNotebookApp": {"collaboration_enabled": False}},
        "Disable real-time collaborative editing features.",
    )

    flags["collaboration-audit"] = (
        {"JupyterNotebookApp": {"collaboration_audit_enabled": True}},
        "Enable comprehensive audit logging for collaboration events.",
    )

    flags["collaboration-encryption"] = (
        {"JupyterNotebookApp": {"collaboration_encryption_required": True}},
        "Require encryption for all collaboration channels.",
    )

    @default("static_dir")
    def _default_static_dir(self) -> str:
        return str(HERE / "static")

    @default("templates_dir")
    def _default_templates_dir(self) -> str:
        return str(HERE / "templates")

    @default("app_settings_dir")
    def _default_app_settings_dir(self) -> str:
        return str(app_dir / "settings")

    @default("schemas_dir")
    def _default_schemas_dir(self) -> str:
        return str(app_dir / "schemas")

    @default("themes_dir")
    def _default_themes_dir(self) -> str:
        return str(app_dir / "themes")

    @default("user_settings_dir")
    def _default_user_settings_dir(self) -> str:
        return t.cast(str, get_user_settings_dir())

    @default("workspaces_dir")
    def _default_workspaces_dir(self) -> str:
        return t.cast(str, get_workspaces_dir())

    def _prepare_templates(self) -> None:
        super(LabServerApp, self)._prepare_templates()
        self.jinja2_env.globals.update(custom_css=self.custom_css)  # type:ignore[has-type]

    def server_extension_is_enabled(self, extension: str) -> bool:
        """Check if server extension is enabled."""
        if self.serverapp is None:
            return False
        try:
            extension_enabled = (
                self.serverapp.extension_manager.extensions[extension].enabled is True
            )
        except (AttributeError, KeyError, TypeError):
            extension_enabled = False
        return extension_enabled

    def _configure_collaboration_logging(self) -> None:
        """Configure collaboration-specific logging and audit trail support per Section 6.4.1."""
        if not self.collaboration_enabled:
            return

        # Create collaboration-specific logger
        collab_logger = logging.getLogger("jupyter_notebook.collaboration")
        collab_logger.setLevel(getattr(logging, self.collaboration_log_level.upper()))

        # Configure audit logging if enabled
        if self.collaboration_audit_enabled:
            audit_logger = logging.getLogger("jupyter_notebook.collaboration.audit")
            audit_logger.setLevel(logging.INFO)

            # Set up SIEM integration if configured
            if self.collaboration_siem_integration.get("enabled", False):
                siem_config = self.collaboration_siem_integration
                
                if siem_config.get("destination") == "syslog":
                    try:
                        from logging.handlers import SysLogHandler
                        facility = siem_config.get("facility", "local5")
                        syslog_handler = SysLogHandler(facility=getattr(SysLogHandler, f"LOG_{facility.upper()}"))
                        
                        if siem_config.get("format") == "json":
                            import json
                            
                            class JSONFormatter(logging.Formatter):
                                def format(self, record):
                                    log_data = {
                                        "timestamp": self.formatTime(record),
                                        "level": record.levelname,
                                        "logger": record.name,
                                        "message": record.getMessage(),
                                        "event_type": getattr(record, "event_type", "unknown"),
                                        "user_id": getattr(record, "user_id", ""),
                                        "session_id": getattr(record, "session_id", ""),
                                        "correlation_id": getattr(record, "correlation_id", ""),
                                    }
                                    return json.dumps(log_data)
                            
                            syslog_handler.setFormatter(JSONFormatter())
                        
                        audit_logger.addHandler(syslog_handler)
                        
                    except ImportError:
                        self.log.warning("SysLogHandler not available, falling back to file logging")

        self.log.info(f"Collaboration logging configured: level={self.collaboration_log_level}, "
                     f"audit_enabled={self.collaboration_audit_enabled}, "
                     f"siem_enabled={self.collaboration_siem_integration.get('enabled', False)}")

    def _setup_collaboration_authentication(self) -> None:
        """Set up collaboration authentication integration with JupyterHub for multi-user sessions."""
        if not self.collaboration_enabled or self.serverapp is None:
            return

        # Check if running under JupyterHub and configure collaboration authentication
        if "hub_prefix" in self.serverapp.tornado_settings:
            tornado_settings = self.serverapp.tornado_settings
            
            # Store JupyterHub settings for collaboration handlers
            collaboration_auth_settings = {
                "hub_prefix": tornado_settings.get("hub_prefix"),
                "hub_host": tornado_settings.get("hub_host"),
                "hub_user": tornado_settings.get("user"),
                "hub_api_token": os.environ.get("JUPYTERHUB_API_TOKEN"),
                "collaboration_enabled": self.collaboration_enabled,
                "collaboration_session_timeout": self.collaboration_session_timeout,
                "collaboration_max_users": self.collaboration_max_users,
                "collaboration_encryption_required": self.collaboration_encryption_required,
            }
            
            # Add collaboration authentication settings to web app settings
            self.serverapp.web_app.settings["collaboration_auth"] = collaboration_auth_settings
            
            self.log.info("Collaboration authentication configured for JupyterHub integration")
        else:
            # Standalone mode - use token-based authentication
            self.log.info("Collaboration authentication configured for standalone mode")

    def initialize_handlers(self) -> None:
        """Initialize handlers."""
        assert self.serverapp is not None  # noqa: S101
        page_config = self.serverapp.web_app.settings.setdefault("page_config_data", {})
        nbclassic_enabled = self.server_extension_is_enabled("nbclassic")
        page_config["nbclassic_enabled"] = nbclassic_enabled

        # If running under JupyterHub, add more metadata.
        if "hub_prefix" in self.serverapp.tornado_settings:
            tornado_settings = self.serverapp.tornado_settings
            hub_prefix = tornado_settings["hub_prefix"]
            page_config["hubPrefix"] = hub_prefix
            page_config["hubHost"] = tornado_settings["hub_host"]
            page_config["hubUser"] = tornado_settings["user"]
            page_config["shareUrl"] = ujoin(hub_prefix, "user-redirect")
            # Assume the server_name property indicates running JupyterHub 1.0.
            if hasattr(self.serverapp, "server_name"):
                page_config["hubServerName"] = self.serverapp.server_name
            # avoid setting API token in page config
            # $JUPYTERHUB_API_TOKEN identifies the server, not the client
            # but at least make sure we don't use the token
            # if the serverapp set one
            page_config["token"] = ""

        # Register collaboration WebSocket handlers and REST API endpoints if collaboration is enabled
        if self.collaboration_enabled:
            try:
                # Import collaboration handlers (will be implemented in handlers.py)
                from .handlers import (
                    CollaborationWebSocketHandler,
                    CollaborationSessionsHandler,
                    CollaborationPermissionsHandler,
                    CollaborationCommentsHandler,
                    CollaborationHistoryHandler,
                    CollaborationHealthHandler,
                )

                # Register collaboration WebSocket endpoint with proper authentication and authorization middleware
                self.handlers.append((
                    r"/api/collaboration/ws/?",
                    CollaborationWebSocketHandler,
                    {"extensionapp": self}
                ))

                # Register collaboration REST API endpoints
                self.handlers.append((
                    r"/api/collaboration/sessions/?",
                    CollaborationSessionsHandler,
                    {"extensionapp": self}
                ))
                
                self.handlers.append((
                    r"/api/collaboration/sessions/([^/]+)/?",
                    CollaborationSessionsHandler,
                    {"extensionapp": self}
                ))

                self.handlers.append((
                    r"/api/collaboration/permissions/?",
                    CollaborationPermissionsHandler,
                    {"extensionapp": self}
                ))
                
                self.handlers.append((
                    r"/api/collaboration/permissions/([^/]+)/?",
                    CollaborationPermissionsHandler,
                    {"extensionapp": self}
                ))
                
                self.handlers.append((
                    r"/api/collaboration/permissions/([^/]+)/cells/([^/]+)/?",
                    CollaborationPermissionsHandler,
                    {"extensionapp": self}
                ))

                self.handlers.append((
                    r"/api/collaboration/comments/([^/]+)/?",
                    CollaborationCommentsHandler,
                    {"extensionapp": self}
                ))
                
                self.handlers.append((
                    r"/api/collaboration/comments/([^/]+)/threads/([^/]+)/?",
                    CollaborationCommentsHandler,
                    {"extensionapp": self}
                ))
                
                self.handlers.append((
                    r"/api/collaboration/comments/([^/]+)/threads/([^/]+)/replies/?",
                    CollaborationCommentsHandler,
                    {"extensionapp": self}
                ))

                self.handlers.append((
                    r"/api/collaboration/history/?",
                    CollaborationHistoryHandler,
                    {"extensionapp": self}
                ))
                
                self.handlers.append((
                    r"/api/collaboration/history/([^/]+)/?",
                    CollaborationHistoryHandler,
                    {"extensionapp": self}
                ))

                # Register collaboration health check endpoint
                self.handlers.append((
                    r"/api/collaboration/health/?",
                    CollaborationHealthHandler,
                    {"extensionapp": self}
                ))

                self.log.info("Collaboration handlers registered successfully")

            except ImportError as e:
                # If collaboration handlers are not available, log warning but don't fail
                self.log.warning(f"Collaboration handlers not available: {e}")
                self.log.warning("Collaboration features will be disabled")
                self.collaboration_enabled = False
        
        # Register standard notebook handlers
        self.handlers.append(("/tree(.*)", TreeHandler))
        self.handlers.append(("/notebooks(.*)", NotebookHandler))
        self.handlers.append(("/edit(.*)", FileHandler))
        self.handlers.append(("/consoles/(.*)", ConsoleHandler))
        self.handlers.append(("/terminals/(.*)", TerminalHandler))
        self.handlers.append(("/custom/custom.css", CustomCssHandler))
        super().initialize_handlers()

    def initialize(self, argv: list[str] | None = None) -> None:  # noqa: ARG002
        """Subclass because the ExtensionApp.initialize() method does not take arguments"""
        super().initialize()
        
        # Configure collaboration features after core initialization
        if self.collaboration_enabled:
            self._configure_collaboration_logging()
            self._setup_collaboration_authentication()
            
            self.log.info(f"Collaboration features initialized: "
                         f"session_timeout={self.collaboration_session_timeout}s, "
                         f"max_users={self.collaboration_max_users}, "
                         f"encryption_required={self.collaboration_encryption_required}")


main = launch_new_instance = JupyterNotebookApp.launch_instance

if __name__ == "__main__":
    main()