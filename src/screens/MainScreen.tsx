import React, { useContext, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  ToastAndroid,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import RNBluetoothClassic, { BluetoothDevice } from 'react-native-bluetooth-classic';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import LinearGradient from 'react-native-linear-gradient';
import * as XLSX from 'xlsx';
import RNFS from 'react-native-fs';
import Share from 'react-native-share';
import SafFileModule from '../../SafFileModule';
import { LogContext } from '../context/LogContext';
import { getItem, setItem, setJSON, getJSON } from '../services/storage';

let dataSubscription: any = null;

export default function MainScreen({ navigation }: { navigation: any }) {
  const isDarkMode = useColorScheme() === 'dark';
  const [isBluetoothEnabled, setIsBluetoothEnabled] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [pairedDevices, setPairedDevices] = useState<BluetoothDevice[]>([]);
  const [unpairedDevices, setUnpairedDevices] = useState<BluetoothDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<BluetoothDevice | null>(null);
  const [status, setStatus] = useState('');
  const [debugMode] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [isAppReady, setIsAppReady] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<any>({});
  const [appState, setAppState] = useState(AppState.currentState);
  const [showDeviceLists, setShowDeviceLists] = useState(false);

  const logCtx = useContext(LogContext);
  const globalIsLogging = logCtx?.isLogging;
  const appendLog = logCtx?.appendLog;

  const isLoggingRef = useRef(globalIsLogging);
  const appendLogRef = useRef(appendLog);

  useEffect(() => {
    isLoggingRef.current = globalIsLogging;
    appendLogRef.current = appendLog;
  }, [globalIsLogging, appendLog]);

  useEffect(() => {
    initializeApp();

    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isScanning) {
        stopScanning();
        return true;
      }
      return false;
    });

    const appStateListener = AppState.addEventListener('change', async (nextAppState) => {
      if (appState.match(/active/) && nextAppState.match(/inactive|background/)) {
        try {
          await RNBluetoothClassic.cancelDiscovery();
        } catch {}
      }
      setAppState(nextAppState);
    });

    return () => {
      backHandler.remove();
      appStateListener.remove();
      if (dataSubscription) {
        dataSubscription.remove();
      }
    };
  }, [appState]);

  const initializeApp = async () => {
    try {
      setStatus('Initializing...');
      await getDeviceInfo();
      await checkBluetoothEnabled();
      const permissionsGranted = await requestPermissions();
      if (permissionsGranted) {
        await fetchPairedDevices();
        const lastAddress = await getItem('lastConnectedDevice');
        if (lastAddress) {
          const paired = await RNBluetoothClassic.getBondedDevices();
          const device = paired.find(d => d.address === lastAddress);
          if (device) {
            try {
              setStatus('Reconnecting to last device...');
              await connectToDevice(device);
            } catch {}
          }
        }
        setStatus('App ready. Tap "Scan for Devices" to start.');
      } else {
        setStatus('Permissions required. Please grant Bluetooth and Location permissions.');
      }
      setIsAppReady(true);
    } catch {
      setStatus('Error initializing app. Please restart.');
    }
  };

  const checkBluetoothEnabled = async () => {
    try {
      const enabled = await RNBluetoothClassic.isBluetoothEnabled();
      setIsBluetoothEnabled(enabled);
      setStatus(enabled ? 'Bluetooth is enabled.' : 'Bluetooth is disabled. Please enable Bluetooth in settings.');
      if (!enabled) ToastAndroid.show('Please enable Bluetooth', ToastAndroid.LONG);
    } catch {
      setStatus('Error checking Bluetooth status.');
    }
  };

  const getDeviceInfo = async () => {
    try {
      const { Platform } = require('react-native');
      const info = {
        manufacturer: Platform.constants?.Brand || 'Unknown',
        model: Platform.constants?.Model || 'Unknown',
        version: Platform.Version,
        apiLevel: Platform.constants?.Version || 'Unknown',
      };
      setDeviceInfo(info);
    } catch {}
  };

  const savePairedDevices = async (devices: BluetoothDevice[]) => {
    try {
      await setJSON('pairedDevices', devices.map(d => ({ address: d.address, name: d.name, bonded: d.bonded })));
    } catch {}
  };

  const loadPairedDevices = async () => {
    try {
      return (await getJSON<any[]>('pairedDevices')) || [];
    } catch {
      return [];
    }
  };

  const requestPermissions = async () => {
    if (Platform.OS !== 'android') return true;
    try {
      const permissions = [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
      ];
      if (Platform.Version >= 31) {
        permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
        permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
      }
      const granted = await PermissionsAndroid.requestMultiple(permissions);
      setPermissionStatus(granted);
      const allGranted = Object.values(granted).every(val => val === PermissionsAndroid.RESULTS.GRANTED);
      if (!allGranted) showPermissionGuidance();
      return allGranted;
    } catch {
      setStatus('Permission error occurred.');
      return false;
    }
  };

  const showPermissionGuidance = () => {
    const manufacturer = deviceInfo?.manufacturer?.toLowerCase() || '';
    let guidance = 'Please grant all permissions in Settings > Apps > Bluetooth Scanner > Permissions';
    if (manufacturer.includes('xiaomi') || manufacturer.includes('mi')) {
      guidance = 'Xiaomi: enable Autostart and disable Battery Saver for this app.';
    } else if (manufacturer.includes('huawei')) {
      guidance = 'Huawei: enable Auto-launch and disable Battery optimization.';
    } else if (manufacturer.includes('oppo') || manufacturer.includes('oneplus')) {
      guidance = 'OPPO/OnePlus: enable Auto-start and disable Battery optimization.';
    } else if (manufacturer.includes('vivo')) {
      guidance = 'Vivo: enable Auto-start and disable Battery saver.';
    }
    Alert.alert('Permissions Required', guidance, [
      { text: 'OK' },
      { text: 'Open Settings', onPress: () => { const { Linking } = require('react-native'); Linking.openSettings(); } },
    ]);
  };

  const fetchPairedDevices = async () => {
    try {
      const granted = await requestPermissions();
      if (!granted) { setStatus('Bluetooth permissions are required to fetch paired devices.'); return; }
      const savedDevices = await loadPairedDevices();
      const systemDevices = await Promise.race([
        RNBluetoothClassic.getBondedDevices(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout getting bonded devices')), 10000)),
      ]) as BluetoothDevice[];
      const realPairedDevices = systemDevices.filter((device: BluetoothDevice) => {
        const dummyNames = ['Unknown Device','Unknown','Bluetooth Device','BT Device','Device','Phone','Mobile','Android','Test Device','Dummy Device'];
        const isDummyName = dummyNames.some(dummy => device.name && device.name.toLowerCase().includes(dummy.toLowerCase()));
        const isGenericAddress = device.address && (device.address.includes('00:00:00') || device.address.includes('FF:FF:FF') || device.address.includes('AA:AA:AA') || device.address.includes('BB:BB:BB'));
        return device.bonded && !isDummyName && !isGenericAddress;
      });
      setPairedDevices(realPairedDevices);
      await savePairedDevices(realPairedDevices);
      setStatus(`Found ${realPairedDevices.length} paired devices.`);
    } catch {
      setStatus('Error loading paired devices.');
    }
  };

  const scanForDevices = async () => {
    if (!isBluetoothEnabled) { setStatus('Bluetooth is disabled. Please enable Bluetooth first.'); ToastAndroid.show('Please enable Bluetooth', ToastAndroid.LONG); return; }
    if (!isAppReady) { setStatus('App is still initializing. Please wait.'); return; }
    if (isScanning) { setStatus('Already scanning. Please wait.'); return; }
    setIsScanning(true);
    setUnpairedDevices([]);
    setStatus('Scanning for devices...');
    try {
      await RNBluetoothClassic.cancelDiscovery();
      await new Promise(res => setTimeout(res, 1000));
      const granted = await requestPermissions();
      if (!granted) { setStatus('Bluetooth permissions are required for scanning.'); setIsScanning(false); return; }
      const bluetoothStillEnabled = await RNBluetoothClassic.isBluetoothEnabled();
      if (!bluetoothStillEnabled) { setStatus('Bluetooth was disabled during scan.'); setIsScanning(false); return; }
      setStatus('Scanning...');
      const discoveryPromise = RNBluetoothClassic.startDiscovery();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Scan timeout after 30 seconds')), 30000));
      const discovered = await Promise.race([discoveryPromise, timeoutPromise]);
      if (discovered && Array.isArray(discovered)) {
        const unpairedOnly = discovered.filter(device => !pairedDevices.some(p => p.address === device.address || (p.name && device.name && p.name === device.name)));
        setUnpairedDevices(unpairedOnly);
        setStatus(unpairedOnly.length === 0 ? 'No new devices found.' : `Found ${unpairedOnly.length} new devices.`);
      } else {
        setStatus('Error: Invalid discovery results.');
      }
    } catch (error) {
      const errorMsg = typeof error === 'object' && error !== null && 'message' in error ? (error as any).message : JSON.stringify(error);
      setStatus('Scan error: ' + errorMsg);
    } finally {
      setIsScanning(false);
    }
  };

  const stopScanning = async () => {
    try { await RNBluetoothClassic.cancelDiscovery(); setIsScanning(false); setStatus('Scan stopped.'); } catch {}
  };

  const connectToDevice = async (device: BluetoothDevice) => {
    try {
      setStatus('Connecting...');
      const granted = await requestPermissions();
      if (!granted) { setStatus('Bluetooth permissions are required to connect.'); return; }
      if (!device.bonded) {
        setStatus(`Pairing with ${device.name || device.address}...`);
        try {
          const pairingPromise = RNBluetoothClassic.pairDevice(device.address);
          const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Pairing timeout')), 15000));
          const paired = await Promise.race([pairingPromise, timeoutPromise]);
          if (!paired) { setStatus('Pairing failed. Please pair the device manually in Bluetooth settings.'); return; }
          setStatus(`Successfully paired with ${device.name || device.address}. Connecting now...`);
          await fetchPairedDevices();
          await savePairedDevices([...pairedDevices, device]);
        } catch (pairingError) {
          setStatus(`Pairing failed: ${pairingError instanceof Error ? pairingError.message : 'Unknown error'}`);
          return;
        }
      }
      const connectionPromise = device.connect();
      const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 20000));
      const connected = await Promise.race([connectionPromise, timeoutPromise]);
      if (connected) {
        setConnectedDevice(device);
        setStatus(`Connected to ${device.name || device.address}!`);
        await setItem('lastConnectedDevice', device.address);
        if (dataSubscription) { dataSubscription.remove(); dataSubscription = null; }
        dataSubscription = device.onDataReceived((event: any) => {
          setStatus('Receiving data...');
          if (appendLogRef.current) appendLogRef.current(event.data);
        });
      } else {
        setStatus(`Failed to connect to ${device.name || device.address}`);
        ToastAndroid.show('Connection failed. Please try again.', ToastAndroid.SHORT);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
      setStatus(`Connection error: ${errorMsg}`);
      ToastAndroid.show('Connection failed. Please try again.', ToastAndroid.SHORT);
    }
  };

  const disconnectDevice = async () => {
    if (!connectedDevice) return;
    try {
      await connectedDevice.disconnect();
      setConnectedDevice(null);
      if (dataSubscription) { dataSubscription.remove(); dataSubscription = null; }
      setStatus('Disconnected.');
    } catch { setStatus('Error disconnecting.'); }
  };

  const removePairedDevice = async (device: BluetoothDevice) => {
    try {
      setStatus(`Removing ${device.name || device.address}...`);
      const granted = await requestPermissions();
      if (!granted) { setStatus('Bluetooth permissions are required to remove paired devices.'); return; }

      if (connectedDevice && connectedDevice.address === device.address) {
        await disconnectDevice();
      }

      const removed = await RNBluetoothClassic.unpairDevice(device.address);
      if (removed) {
        const updatedPairedDevices = pairedDevices.filter(d => d.address !== device.address);
        setPairedDevices(updatedPairedDevices);
        await savePairedDevices(updatedPairedDevices);
        setStatus(`Successfully removed ${device.name || device.address}.`);
        // Optionally refresh available devices shortly after
        setTimeout(async () => {
          try {
            setIsScanning(true);
            setUnpairedDevices([]);
            const discovered = await RNBluetoothClassic.startDiscovery();
            setUnpairedDevices(discovered);
          } catch {} finally { setIsScanning(false); }
        }, 1000);
      } else {
        setStatus(`Failed to remove ${device.name || device.address}`);
      }
    } catch {
      setStatus('Error removing paired device.');
    }
  };

  const showDeviceInfo = (device: BluetoothDevice) => {
    Alert.alert(device.name || 'Device Info', `Name: ${device.name || 'Unknown'}\nAddress: ${device.address}\nBonded: ${device.bonded ? 'Yes' : 'No'}`, [{ text: 'OK' }]);
  };

  const styles = getStyles();

  return (
    <View style={[styles.container, isDarkMode && styles.darkContainer]}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <View style={[styles.customHeader, isDarkMode && styles.customHeaderDark]}>
        {showDeviceLists && (
          <TouchableOpacity onPress={() => setShowDeviceLists(false)} style={styles.headerBackButton} activeOpacity={0.8}>
            <MaterialIcons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>
        )}
        <Text style={styles.customHeaderTitle}>Bluetooth Classic</Text>
      </View>

      <View style={styles.controls}>
        {!showDeviceLists ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', height: '60%', minHeight: 300, marginTop: 60 }}>
            <TouchableOpacity style={styles.rectButton} onPress={() => setShowDeviceLists(true)}>
              <Text style={styles.rectButtonText}>Connect New Device</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.rectButton, { marginTop: 20, borderColor: '#34C759', backgroundColor: 'transparent' }]} onPress={() => navigation.navigate('Logs', { connectedDevice })}>
              <Text style={[styles.rectButtonText, { color: '#34C759' }]}>Get Logs</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity activeOpacity={0.9} onPress={scanForDevices} disabled={isScanning || !isBluetoothEnabled} style={styles.scanButtonWrapper}>
            <LinearGradient colors={isScanning ? ['#666', '#666'] : ['#00B4DB', '#0083B0']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.scanGradient, isScanning && styles.scanningButton]}>
              <MaterialIcons name="search" size={22} color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.scanButtonText}>{isScanning ? 'Scanning...' : 'Scan for Devices'}</Text>
            </LinearGradient>
          </TouchableOpacity>
        )}
      </View>

      {showDeviceLists && (
      <View style={styles.mainContent}>
        <View style={[styles.devicesCard, isDarkMode && styles.devicesCardDark]}>
          <ScrollView style={styles.devicesContainer}>
            <Text style={[styles.sectionTitle, isDarkMode && styles.darkText]}>Paired devices</Text>
            {pairedDevices.length === 0 ? (
              <View style={styles.emptyState}>
                <MaterialIcons name="bluetooth-searching" size={40} color="#888" />
                <Text style={[styles.emptyText, isDarkMode && styles.darkText]}>No paired devices found.</Text>
              </View>
            ) : (
              pairedDevices.map(item => {
                const isConnected = connectedDevice && item.address === connectedDevice.address;
                return (
                  <TouchableOpacity key={item.address} onPress={async () => { if (isConnected) { await disconnectDevice(); } else { await connectToDevice(item); } }} style={[styles.deviceCard, isDarkMode && styles.deviceCardDark, isConnected && styles.connectedDeviceRow]} activeOpacity={0.8}>
                    <View style={styles.deviceAvatar}>
                      <MaterialIcons name="bluetooth" size={22} color={isConnected ? 'limegreen' : '#00B4DB'} />
                    </View>
                    <View style={styles.deviceInfoColumn}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={[styles.deviceNameRow, isDarkMode && styles.darkText, isConnected && styles.connectedDeviceText]}>
                          {item.name || 'Unknown Device'}
                        </Text>
                        {isConnected && <MaterialIcons name="bluetooth-connected" size={20} color="limegreen" style={{ marginLeft: 8 }} />}
                      </View>
                      <Text style={[styles.deviceAddressRow, isDarkMode && styles.darkText, isConnected && styles.connectedDeviceText]}>
                        {item.address}
                      </Text>
                    </View>
                    <View style={styles.deviceActionsRow}>
                      <TouchableOpacity onPress={() => showDeviceInfo(item)} style={styles.iconButton}>
                        <MaterialIcons name="info" size={22} color="#B3B3B3" />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => removePairedDevice(item)} style={styles.iconButton}>
                        <MaterialIcons name="delete" size={22} color="#FF3B30" />
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}

            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, isDarkMode && styles.darkText]}>Available devices</Text>
            </View>
            {isScanning ? (
              <View style={{ alignItems: 'center', marginTop: 20 }}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={{ color: '#888', marginTop: 10 }}>Scanning for devices...</Text>
                <Text style={{ color: '#aaa', fontSize: 12, marginTop: 4 }}>Devices will appear here as soon as they are found.</Text>
              </View>
            ) : (
              unpairedDevices.length === 0 ? (
                <View style={styles.emptyState}>
                  <MaterialIcons name="devices-other" size={40} color="#888" />
                  <Text style={[styles.emptyText, isDarkMode && styles.darkText]}>No available devices found.</Text>
                </View>
              ) : (
                unpairedDevices.map(item => (
                  <TouchableOpacity key={item.address} style={[styles.deviceCard, isDarkMode && styles.deviceCardDark]} onPress={() => connectToDevice(item)} disabled={isScanning}>
                    <View style={styles.deviceAvatar}>
                      <MaterialIcons name="devices" size={22} color="#00B4DB" />
                    </View>
                    <View style={styles.deviceInfoColumn}>
                      <Text style={[styles.deviceNameRow, isDarkMode && styles.darkText]}>{item.name || 'Unknown Device'}</Text>
                      <Text style={[styles.deviceAddressRow, isDarkMode && styles.darkText]}>{item.address}</Text>
                    </View>
                  </TouchableOpacity>
                ))
              )
            )}
            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
      )}
    </View>
  );
}

function getStyles() {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    darkContainer: { backgroundColor: '#1a1a1a' },
    customHeader: { width: '100%', backgroundColor: '#007AFF', paddingTop: 40, paddingBottom: 16, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 2 },
    customHeaderDark: { backgroundColor: '#0051A8' },
    customHeaderTitle: { color: '#fff', fontSize: 22, fontWeight: 'bold', letterSpacing: 1 },
    headerBackButton: { position: 'absolute', left: 16, top: 40, padding: 6 },
    controls: { paddingHorizontal: 20, marginBottom: 8, alignItems: 'center' },
    scanButtonWrapper: { width: '100%', paddingHorizontal: 16, marginTop: 10, marginBottom: 12 },
    scanGradient: { paddingVertical: 15, borderRadius: 12, alignItems: 'center', justifyContent: 'center', width: '100%', flexDirection: 'row', shadowColor: '#0083B0', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 3 },
    scanningButton: { backgroundColor: '#666' },
    scanButtonText: { color: 'white', fontSize: 16, fontWeight: '600' },
    rectButton: { width: 220, height: 56, borderRadius: 12, borderWidth: 2, borderColor: '#00BFFF', justifyContent: 'center', alignItems: 'center', backgroundColor: 'transparent', marginVertical: 20, shadowColor: '#00BFFF', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 3 },
    rectButtonText: { color: '#00BFFF', fontSize: 18, textAlign: 'center', fontWeight: 'bold', letterSpacing: 0.5 },
    mainContent: { flex: 1 },
    devicesCard: { flex: 1, marginHorizontal: 16, marginTop: 12, marginBottom: 16, borderRadius: 16, backgroundColor: '#ffffff', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.1, shadowRadius: 10, elevation: 4, overflow: 'hidden' },
    devicesCardDark: { backgroundColor: '#141414' },
    devicesContainer: { flex: 1, paddingHorizontal: 20 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10 },
    sectionTitle: { fontSize: 18, fontWeight: '600', color: '#333', marginTop: 20, marginBottom: 10 },
    emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 20, gap: 8 },
    emptyText: { fontSize: 14, color: '#888', textAlign: 'center', marginBottom: 10 },
    deviceCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, backgroundColor: '#fff', marginBottom: 10, borderWidth: 1, borderColor: '#eee' },
    deviceCardDark: { backgroundColor: '#1f1f1f', borderColor: '#2a2a2a' },
    deviceAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,180,219,0.15)', marginRight: 10 },
    deviceInfoColumn: { flex: 1, flexDirection: 'column' },
    deviceNameRow: { fontSize: 16, color: '#111', fontWeight: '500' },
    deviceAddressRow: { fontSize: 12, color: '#B3B3B3' },
    deviceActionsRow: { flexDirection: 'row', alignItems: 'center', marginLeft: 10 },
    iconButton: { padding: 6, marginLeft: 2 },
    darkText: { color: '#fff' },
    connectedDeviceRow: { backgroundColor: 'rgba(50,205,50,0.12)', borderColor: 'limegreen', borderWidth: 2, borderRadius: 12, shadowColor: 'limegreen', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
    connectedDeviceText: { color: 'limegreen', fontWeight: 'bold' },
  });
}


