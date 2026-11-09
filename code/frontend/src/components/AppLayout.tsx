import React, { ReactNode, useEffect, useRef, useState } from 'react';
import {
  AppBar,
  Avatar,
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  SvgIcon,
  Toolbar,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { DebugItSession } from '../types/api';
import { SignInLink, pillSx, visuallyHidden } from './SessionControl';

export const PANEL_WIDTH = 240;

export type AlertsPlacement = 'side' | 'below';

type ShownSession = Extract<DebugItSession, { state: 'signed-out' | 'signed-in' }>;

export interface LayoutItem {
  label: string;
  current: boolean;
  onSelect: () => void;
}

export interface LayoutAlerts {
  count: number;
  onOpen: (anchor: HTMLElement, placement: AlertsPlacement) => void;
}

export interface LayoutAccount {
  session: ShownSession;
  onSignOut: () => void;
  signingOut: boolean;
  /** Present only while personal keys are on. */
  personalKey?: { onOpen: () => void };
}

/** What App builds once and every view passes on to AppLayout. */
export interface LayoutProps {
  heading: string;
  /** Dashboard, Debug it settings and Security, in that order, only those that show. */
  items: LayoutItem[];
  /** Moves the focus to the current item when the panel mounts (after a view was chosen in it). */
  focusCurrentItem?: boolean;
  account: LayoutAccount | null;
  themeToggle: ReactNode;
}

interface AppLayoutProps extends LayoutProps {
  /** Only the Dashboard view passes it: its hooks own the count and the popover. */
  alerts?: LayoutAlerts;
  children: ReactNode;
}

const MenuIcon: React.FC = () => (
  <SvgIcon viewBox="0 0 24 24">
    <path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z" />
  </SvgIcon>
);

const itemSx = {
  borderRadius: 1,
  py: 0.75,
  width: '100%',
  textAlign: 'left',
  '&.Mui-selected': { fontWeight: 700 },
} as const;

interface PanelProps extends Omit<AppLayoutProps, 'children'> {
  /** The wide panel's heading is the page's h1; the drawer's is not a second one. */
  headingComponent: 'h1' | 'p';
  /** Called after any item is chosen, so the drawer can close. */
  onChoose: () => void;
  onAlerts: (event: React.MouseEvent<HTMLElement>) => void;
}

const Panel: React.FC<PanelProps> = ({
  heading,
  headingComponent,
  items,
  focusCurrentItem = false,
  alerts,
  account,
  themeToggle,
  onChoose,
  onAlerts,
}) => {
  const choose = (action: () => void) => () => {
    onChoose();
    action();
  };

  const rows: ReactNode[] = items.map((item) => (
    <ListItem key={item.label} disablePadding>
      <ListItemButton
        component="button"
        selected={item.current}
        autoFocus={focusCurrentItem && item.current}
        aria-current={item.current ? 'page' : undefined}
        onClick={choose(item.onSelect)}
        sx={itemSx}
      >
        <ListItemText
          primary={item.label}
          slotProps={{ primary: { sx: { fontSize: 14, fontWeight: item.current ? 700 : 500 } } }}
        />
      </ListItemButton>
    </ListItem>
  ));

  if (alerts) {
    const dashboardIndex = items.findIndex((item) => item.label === 'Dashboard');
    rows.splice(
      dashboardIndex + 1,
      0,
      <ListItem key="Alerts" disablePadding>
        <ListItemButton
          component="button"
          onClick={(event) => {
            onChoose();
            onAlerts(event);
          }}
          aria-haspopup="dialog"
          aria-label={alerts.count > 0 ? `Alerts — ${alerts.count} active` : 'Alerts'}
          sx={itemSx}
        >
          <ListItemText primary="Alerts" slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 500 } } }} />
          {alerts.count > 0 && (
            <Box
              component="span"
              aria-hidden
              sx={{
                ml: 1,
                minWidth: 20,
                height: 20,
                px: 0.75,
                borderRadius: 999,
                bgcolor: 'error.main',
                color: 'error.contrastText',
                fontSize: 12,
                fontWeight: 700,
                lineHeight: '20px',
                textAlign: 'center',
              }}
            >
              {alerts.count > 99 ? '99+' : alerts.count}
            </Box>
          )}
        </ListItemButton>
      </ListItem>,
    );
  }

  return (
    <Box component="nav" aria-label="Main" sx={{ pb: account ? 0 : 1.5 }}>
      <Box sx={{ px: 2, pt: 2.5, pb: 1.5, display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Typography variant="h6" component={headingComponent} sx={{ fontWeight: 700, lineHeight: 1.3, m: 0, flex: 1, minWidth: 0 }}>
          {heading}
        </Typography>
        {themeToggle}
      </Box>

      {rows.length > 0 && <List sx={{ px: 1, py: 0, display: 'grid', gap: 0.25 }}>{rows}</List>}

      {account && (
        <>
          <Divider sx={{ mt: 1.5 }} />
          <Box sx={{ px: 2, py: 2, display: 'grid', gap: 1.25, justifyItems: 'start' }}>
            {account.session.state === 'signed-out' ? (
              <SignInLink />
            ) : (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, width: '100%' }}>
                  <Avatar aria-hidden sx={{ width: 32, height: 32, fontSize: 15, fontWeight: 700, bgcolor: 'primary.main' }}>
                    {account.session.login.charAt(0).toUpperCase()}
                  </Avatar>
                  <Typography
                    component="span"
                    noWrap
                    title={account.session.login}
                    sx={{ fontSize: 13, fontWeight: 600, color: 'text.primary', minWidth: 0, flex: 1 }}
                  >
                    <Box component="span" sx={visuallyHidden}>
                      Signed in as{' '}
                    </Box>
                    {account.session.login}
                  </Typography>
                  <Button
                    variant="outlined"
                    color="inherit"
                    size="small"
                    onClick={choose(account.onSignOut)}
                    disabled={account.signingOut}
                    sx={(theme) => ({ ...pillSx(theme), flex: 'none' })}
                  >
                    Sign out
                  </Button>
                </Box>
                {account.personalKey && (
                  <Button
                    variant="outlined"
                    color="inherit"
                    size="small"
                    onClick={choose(account.personalKey.onOpen)}
                    aria-haspopup="dialog"
                    sx={pillSx}
                  >
                    Personal key
                  </Button>
                )}
              </>
            )}
          </Box>
        </>
      )}
    </Box>
  );
};

/**
 * The page frame: a side panel fixed to the left on a wide window, a top bar
 * with a menu button that opens the same panel as a drawer on a narrow one.
 * Only one of the two is in the page at a time.
 */
const AppLayout: React.FC<AppLayoutProps> = ({ children, ...props }) => {
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('md'), { noSsr: true });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  // A drawer left open while the window widened must not reopen when it narrows again.
  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide]);

  const openAlerts = (event: React.MouseEvent<HTMLElement>) => {
    if (!props.alerts) return;
    if (wide) {
      props.alerts.onOpen(event.currentTarget, 'side');
    } else if (menuButton.current) {
      props.alerts.onOpen(menuButton.current, 'below');
    }
  };

  if (wide) {
    return (
      <>
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            bottom: 0,
            width: PANEL_WIDTH,
            overflowY: 'auto',
            bgcolor: 'background.paper',
            borderRight: '1px solid',
            borderColor: 'divider',
            zIndex: theme.zIndex.appBar,
          }}
        >
          <Panel {...props} headingComponent="h1" onChoose={() => {}} onAlerts={openAlerts} />
        </Box>
        <Box sx={{ ml: `${PANEL_WIDTH}px` }}>{children}</Box>
      </>
    );
  }

  return (
    <>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar variant="dense" sx={{ gap: 1 }}>
          <IconButton
            ref={menuButton}
            edge="start"
            color="inherit"
            aria-label="Open menu"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" component="h1" sx={{ fontWeight: 700 }}>
            {props.heading}
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        slotProps={{ paper: { sx: { width: PANEL_WIDTH } } }}
      >
        <Panel
          {...props}
          headingComponent="p"
          onChoose={() => setDrawerOpen(false)}
          onAlerts={openAlerts}
        />
      </Drawer>
      {children}
    </>
  );
};

export default AppLayout;
