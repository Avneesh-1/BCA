import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LogProvider } from './context/LogContext';
import MainScreen from './screens/MainScreen';
import LogsScreen from './screens/LogsScreen';

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  return (
    <LogProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Main" screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Main" component={MainScreen} />
          <Stack.Screen name="Logs" component={LogsScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </LogProvider>
  );
}


