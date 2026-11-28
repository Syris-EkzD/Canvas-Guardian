import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { View } from 'react-native';
import { scenarios } from '../src/api/fixture-client.ts';
import { demo } from '../src/api/store.ts';
import { Button, Card, Copy, Screen, StatusContent, styles, useDemo } from '../src/ui';

export default function Settings() {
  const s=useDemo();
  useFocusEffect(useCallback(()=>{
    const current=demo.getState();
    if(!current.status.data&&!current.status.error)void demo.loadStatus();
  },[]));
  return <Screen><Copy kind="heading">Settings and status</Copy><Copy tone="muted">Read-only configuration. No credentials, connection, integration or setting can be changed.</Copy>
    <StatusContent/><Card><Copy kind="title">Demo test controls</Copy>
      <Copy kind="small">These change only in-memory synthetic responses, not Guardian settings. After choosing a scenario, open a view and refresh to exercise it. Reset demo clears the fixture cache and simulated authorization lock.</Copy>
      <View style={styles.row}>{scenarios.map(scenario=><Button key={scenario} label={scenario==='normal'?'Reset demo':scenario} selected={s.scenario===scenario} disabled={!!s.locked&&scenario!=='normal'} onPress={()=>demo.setScenario(scenario)}/>)}</View>
    </Card></Screen>;
}
