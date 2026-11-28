import { Tabs, router } from 'expo-router';
import { Text } from 'react-native';
import { Button, usePalette } from '../../src/ui';

export default function TabsLayout() {
  const p=usePalette();
  return <Tabs screenOptions={{headerStyle:{backgroundColor:p.surface},headerTintColor:p.text,tabBarStyle:{backgroundColor:p.surface},tabBarActiveTintColor:p.accent,tabBarInactiveTintColor:p.muted,
    headerRight:()=> <Button label="Settings" onPress={()=>router.push('/settings')}/>}}>
    <Tabs.Screen name="index" options={{title:'Home',headerTitle:'Guardian',tabBarIcon:({color})=><Text accessible={false} style={{color,fontSize:20}}>⌂</Text>}}/>
    <Tabs.Screen name="planner" options={{title:'Planner',tabBarIcon:({color})=><Text accessible={false} style={{color,fontSize:20}}>▤</Text>}}/>
  </Tabs>;
}
