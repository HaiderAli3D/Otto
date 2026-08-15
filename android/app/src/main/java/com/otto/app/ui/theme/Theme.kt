package com.otto.app.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

private val DarkColors = darkColorScheme(
    primary = OttoBlueDark,
    secondary = OttoAmber,
    background = OttoSurfaceDark,
)

private val LightColors = lightColorScheme(
    primary = OttoBlue,
    secondary = OttoAmber,
)

@Composable
fun OttoTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    // Material You dynamic color is available on Android 12+ (API 31).
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(
        colorScheme = colorScheme,
        typography = OttoTypography,
        content = content,
    )
}
