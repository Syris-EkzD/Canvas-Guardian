import { Stack } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { usePalette } from '../src/ui';

export default function Layout() {
  const dark=useColorScheme()==='dark', p=usePalette();
  const theme=dark?DarkTheme:DefaultTheme;
  return <ThemeProvider value={{...theme,colors:{...theme.colors,background:p.bg,card:p.surface,text:p.text,primary:p.accent,border:p.line}}}>
    <StatusBar style={dark?'light':'dark'}/>
    <Stack screenOptions={{headerTintColor:p.accent,headerStyle:{backgroundColor:p.surface},contentStyle:{backgroundColor:p.bg}}}>
      <Stack.Screen name="(tabs)" options={{headerShown:false}}/>
      <Stack.Screen name="activity/[key]" options={{title:'Activity summary'}}/>
      <Stack.Screen name="settings" options={{title:'Settings · Demo'}}/>
    </Stack>
  </ThemeProvider>;
}
