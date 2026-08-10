/**
 * Color intention that you want to used in your theme
 * @param {JsonObject} theme Theme customization object
 */

export default function themePalette(theme) {
    return {
        mode: theme?.customization?.navType,
        transparent: theme.colors?.transparent,
        common: {
            black: theme.colors?.darkPaper,
            dark: theme.colors?.darkPrimaryMain
        },
        primary: {
            light: theme.customization.isDarkMode ? theme.colors?.darkPrimaryLight : theme.colors?.primaryLight,
            main: theme.colors?.primaryMain,
            dark: theme.customization.isDarkMode ? theme.colors?.darkPrimaryDark : theme.colors?.primaryDark,
            200: theme.customization.isDarkMode ? theme.colors?.darkPrimary200 : theme.colors?.primary200,
            800: theme.customization.isDarkMode ? theme.colors?.darkPrimary800 : theme.colors?.primary800
        },
        secondary: {
            light: theme.customization.isDarkMode ? theme.colors?.darkSecondaryLight : theme.colors?.secondaryLight,
            main: theme.customization.isDarkMode ? theme.colors?.darkSecondaryMain : theme.colors?.secondaryMain,
            dark: theme.customization.isDarkMode ? theme.colors?.darkSecondaryDark : theme.colors?.secondaryDark,
            200: theme.colors?.secondary200,
            800: theme.colors?.secondary800
        },
        error: {
            light: theme.colors?.errorLight,
            main: theme.colors?.errorMain,
            dark: theme.colors?.errorDark
        },
        orange: {
            light: theme.colors?.orangeLight,
            main: theme.colors?.orangeMain,
            dark: theme.colors?.orangeDark
        },
        teal: {
            light: theme.colors?.tealLight,
            main: theme.colors?.tealMain,
            dark: theme.colors?.tealDark
        },
        warning: {
            light: theme.colors?.warningLight,
            main: theme.colors?.warningMain,
            dark: theme.colors?.warningDark
        },
        success: {
            light: theme.colors?.successLight,
            200: theme.colors?.success200,
            main: theme.colors?.successMain,
            dark: theme.colors?.successDark
        },
        grey: {
            50: theme.colors?.grey50,
            100: theme.colors?.grey100,
            200: theme.colors?.grey200,
            300: theme.colors?.grey300,
            500: theme.darkTextSecondary,
            600: theme.heading,
            700: theme.darkTextPrimary,
            900: theme.textDark
        },
        dark: {
            light: theme.colors?.darkTextPrimary,
            main: theme.colors?.darkLevel1,
            dark: theme.colors?.darkLevel2,
            800: theme.colors?.darkBackground,
            900: theme.colors?.darkPaper
        },
        text: {
            primary: theme.darkTextPrimary,
            secondary: theme.darkTextSecondary,
            dark: theme.textDark,
            hint: theme.colors?.grey100,
            // UI-06. There was no `disabled` here, so MUI fell back to its own default of
            // rgba(0,0,0,0.26) — a LIGHT-theme token. On the dark background (#16181b) that
            // composites to 1.06:1, i.e. black text on near-black: the label of a disabled button is
            // invisible, not merely low-contrast. WCAG AA wants 4.5:1 for body text.
            //
            // Disabled controls are exempt from the AA contrast minimum, but "exempt" is about
            // conformance, not about whether a user can read the button they are wondering why they
            // cannot press. These values clear 4.5:1 against their own backgrounds while still
            // reading as clearly inactive next to the primary text.
            disabled: theme.customization.isDarkMode ? 'rgba(219, 228, 255, 0.62)' : 'rgba(28, 32, 40, 0.62)'
        },
        background: {
            paper: theme.paper,
            default: theme.backgroundDefault
        },
        textBackground: {
            main: theme.customization.isDarkMode ? theme.colors?.darkPrimary800 : theme.colors?.grey50,
            border: theme.customization.isDarkMode ? theme.colors?.transparent : theme.colors?.grey400
        },
        card: {
            main: theme.customization.isDarkMode ? theme.colors?.darkPrimaryMain : theme.colors?.paper,
            light: theme.customization.isDarkMode ? theme.colors?.darkPrimary200 : theme.colors?.paper,
            hover: theme.customization.isDarkMode ? theme.colors?.darkPrimary800 : theme.colors?.paper
        },
        asyncSelect: {
            main: theme.customization.isDarkMode ? theme.colors?.darkPrimary800 : theme.colors?.grey50
        },
        timeMessage: {
            main: theme.customization.isDarkMode ? theme.colors?.darkLevel2 : theme.colors?.grey200
        },
        canvasHeader: {
            deployLight: theme.colors?.primaryLight,
            deployDark: theme.colors?.primaryDark,
            saveLight: theme.colors?.secondaryLight,
            saveDark: theme.colors?.secondaryDark,
            settingsLight: theme.colors?.grey300,
            settingsDark: theme.colors?.grey700
        },
        codeEditor: {
            main: theme.customization.isDarkMode ? theme.colors?.darkPrimary800 : theme.colors?.primaryLight
        },
        nodeToolTip: {
            background: theme.customization.isDarkMode ? theme.colors?.darkPrimary800 : theme.colors?.paper,
            color: theme.customization.isDarkMode ? theme.colors?.paper : 'rgba(0, 0, 0, 0.87)'
        }
    }
}
