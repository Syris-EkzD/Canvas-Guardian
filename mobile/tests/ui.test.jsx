import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ActivityRow, Button, Screen, ViewContent, StatusContent } from '../src/ui';
import { demo } from '../src/api/store.ts';
import { createFixtureClient } from '../src/api/fixture-client.ts';
import { validatePage } from '../src/api/validate.ts';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
beforeEach(() => { demo.setScenario('normal', createFixtureClient('normal',0)); jest.clearAllMocks(); });
test('demo label and accessible selected/disabled controls', () => {
  const press=jest.fn();
  render(<Screen><Button label="Today" selected onPress={press}/><Button label="Retry" disabled onPress={press}/></Screen>);
  expect(screen.getByText(/DEMO · Synthetic/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button',{name:/Today/}));
  fireEvent.press(screen.getByRole('button',{name:'Retry'}));
  expect(press).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button',{name:/Today/})).toHaveAccessibilityState({selected:true});
});
test('row routes with stable activity identity and no external launch', async () => {
  const q={view:'pending',limit:50,offset:0};
  const data=validatePage(await createFixtureClient('normal',0).activities(q),q);
  render(<ActivityRow activity={data.items[0]} view="pending" evaluatedAt={data.evaluatedAt}/>);
  fireEvent.press(screen.getByRole('button',{name:/Worksheet.*Overdue/i}));
  expect(router.push).toHaveBeenCalledWith({pathname:'/activity/[key]',params:{key:'42:103',view:'pending'}});
});
test('a stale empty snapshot is not presented as a new empty view', async () => {
  const q={view:'today',limit:50,offset:0};
  const data=validatePage(await createFixtureClient('empty',0).activities(q),q);
  render(<ViewContent view="today" state={{snapshot:{data,retrievedAt:Date.now()},busy:false,stale:true}}/>);
  expect(screen.getByText(/Stale — previous complete/)).toBeTruthy();
  expect(screen.getByText(/Previous snapshot was empty/)).toBeTruthy();
  expect(screen.queryByText('No activities in this view.')).toBeNull();
});
test('authorization lock hides previous status', async () => {
  await demo.loadStatus();
  demo.setScenario('forbidden',createFixtureClient('forbidden',0));await demo.loadStatus();
  render(<StatusContent/>);
  expect(screen.getByText(/Demo access denied/)).toBeTruthy();
  expect(screen.queryByText(/Monitoring: running/)).toBeNull();
});
