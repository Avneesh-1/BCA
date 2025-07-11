/**
 * Bluetooth Classic Scanner and Connector
 * Can connect to any Bluetooth Classic device (ESP32, Arduino, sensors, etc.)
 */

import React, { useState, useEffect, useRef, useContext, createContext } from 'react';
import {
  AppState,
  StatusBar,
  StyleSheet,
  useColorScheme,
  View,
  Text,
  TouchableOpacity,
  Alert,
  SafeAreaView,
  ScrollView,
  FlatList,
  TextInput,
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  ToastAndroid,
  BackHandler,
} from 'react-native';
import RNBluetoothClassic, { BluetoothDevice } from 'react-native-bluetooth-classic';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as XLSX from 'xlsx';
import RNFS from 'react-native-fs';
import Share from 'react-native-share';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import SafFileModule from './SafFileModule';

const Stack = createNativeStackNavigator();

let dataSubscription: any = null;

// Log context for global log state
type LogEntry = { timestamp: string; data: string };
type LogContextType = {
  isLogging: boolean;
  logData: LogEntry[];
  startLogging: () => void;
  stopLogging: () => void;
  appendLog: (data: string) => void;
  clearLogs: () => void;
};

const LogContext = createContext<LogContextType | null>(null);

function LogProvider({ children }: { children: React.ReactNode }) {
  const [isLogging, setIsLogging] = useState(false);
  const [logData, setLogData] = useState<LogEntry[]>([]);

  const startLogging = () => {
    setIsLogging(true);
    // Don't clear existing data - we want to keep it
  };
  const stopLogging = () => setIsLogging(false);
  const appendLog = (data: string) => {
    setLogData(prev => [...prev, { timestamp: new Date().toISOString(), data }]);
  };
  const clearLogs = () => setLogData([]);

  return (
    <LogContext.Provider value={{ isLogging, logData, startLogging, stopLogging, appendLog, clearLogs }}>
      {children}
    </LogContext.Provider>
  );
}

async function requestStoragePermission() {
  if (Platform.OS === 'android') {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      {
        title: 'Storage Permission',
        message: 'App needs access to your storage to save logs.',
        buttonNeutral: 'Ask Me Later',
        buttonNegative: 'Cancel',
        buttonPositive: 'OK',
      },
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }
  return true;
}

function MainScreen({ navigation }: { navigation: any }) {
  const isDarkMode = useColorScheme() === 'dark';
  const [isBluetoothEnabled, setIsBluetoothEnabled] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [pairedDevices, setPairedDevices] = useState<BluetoothDevice[]>([]);
  const [unpairedDevices, setUnpairedDevices] = useState<BluetoothDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<BluetoothDevice | null>(null);
  const [message, setMessage] = useState('');
  const [receivedData, setReceivedData] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [debugMode, setDebugMode] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [isAppReady, setIsAppReady] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<any>({});
  const [appState, setAppState] = useState(AppState.currentState);
  const [showDeviceLists, setShowDeviceLists] = useState(false);
  const logCtx = useContext(LogContext);
  const globalIsLogging = logCtx?.isLogging;
  const appendLog = logCtx?.appendLog;

  // Add refs for latest values
  const isLoggingRef = useRef(globalIsLogging);
  const appendLogRef = useRef(appendLog);

  useEffect(() => {
    isLoggingRef.current = globalIsLogging;
    appendLogRef.current = appendLog;
  }, [globalIsLogging, appendLog]);

  useEffect(() => {
    initializeApp();
    
    // Handle back button to prevent app from becoming unresponsive
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isScanning) {
        stopScanning();
        return true;
      }
      return false;
    });

    const appStateListener = AppState.addEventListener('change', async (nextAppState) => {
      if (appState.match(/active/) && nextAppState.match(/inactive|background/)) {
        // App is going to background, cancel discovery
        try {
          await RNBluetoothClassic.cancelDiscovery();
          console.log('Cancelled discovery on background.');
        } catch (e) {
          console.log('No discovery to cancel on background:', e);
        }
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
      console.log('Initializing app...');
      setStatus('Initializing...');
      
      // Get device info first
      await getDeviceInfo();
      
      // Check Bluetooth state
      await checkBluetoothEnabled();
      
      // Request permissions
      const permissionsGranted = await requestPermissions();
      
      if (permissionsGranted) {
        await fetchPairedDevices();
        // Auto-reconnect logic
        const lastAddress = await AsyncStorage.getItem('lastConnectedDevice');
        if (lastAddress) {
          const paired = await RNBluetoothClassic.getBondedDevices();
          const device = paired.find(d => d.address === lastAddress);
          if (device) {
            try {
              setStatus('Reconnecting to last device...');
              await connectToDevice(device);
            } catch (e) {
              setStatus('Could not auto-reconnect to last device.');
            }
          }
        }
        setStatus('App ready. Tap "Scan for Devices" to start.');
      } else {
        setStatus('Permissions required. Please grant Bluetooth and Location permissions.');
      }
      
      setIsAppReady(true);
    } catch (error) {
      console.error('App initialization error:', error as any);
      setStatus('Error initializing app. Please restart.');
    }
  };

  const checkBluetoothEnabled = async () => {
    try {
      console.log('Checking Bluetooth status...');
      const enabled = await RNBluetoothClassic.isBluetoothEnabled();
      setIsBluetoothEnabled(enabled);
      console.log('Bluetooth enabled:', enabled);
      
      if (!enabled) {
        setStatus('Bluetooth is disabled. Please enable Bluetooth in settings.');
        ToastAndroid.show('Please enable Bluetooth', ToastAndroid.LONG);
      } else {
        setStatus('Bluetooth is enabled.');
      }
    } catch (error) {
      console.error('Error checking Bluetooth status:', error as any);
      setStatus('Error checking Bluetooth status.');
    }
  };

  const getDeviceInfo = async () => {
    try {
      const { Platform } = require('react-native');
      const deviceInfo = {
        manufacturer: Platform.constants?.Brand || 'Unknown',
        model: Platform.constants?.Model || 'Unknown',
        version: Platform.Version,
        apiLevel: Platform.constants?.Version || 'Unknown',
      };
      setDeviceInfo(deviceInfo);
      console.log('Device Info:', deviceInfo);
    } catch (error) {
      console.error('Error getting device info:', error as any);
    }
  };

  const savePairedDevices = async (devices: BluetoothDevice[]) => {
    try {
      const devicesToSave = devices.map(device => ({
        address: device.address,
        name: device.name,
        bonded: device.bonded,
      }));
      await AsyncStorage.setItem('pairedDevices', JSON.stringify(devicesToSave));
      console.log('Saved paired devices to storage:', devicesToSave.length);
    } catch (error) {
      console.error('Error saving paired devices:', error as any);
    }
  };

  const loadPairedDevices = async () => {
    try {
      const savedDevices = await AsyncStorage.getItem('pairedDevices');
      if (savedDevices) {
        const parsedDevices = JSON.parse(savedDevices);
        console.log('Loaded paired devices from storage:', parsedDevices.length);
        return parsedDevices;
      }
    } catch (error) {
      console.error('Error loading paired devices:', error as any);
    }
    return [];
  };

  const requestPermissions = async () => {
    if (Platform.OS !== 'android') return true;
    
    try {
      console.log('Requesting permissions...');
      
      const permissions = [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
      ];
      
      // Add Android 12+ permissions
      if (Platform.Version >= 31) {
        permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
        permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
      }
      
      console.log('Requesting permissions:', permissions);
      const granted = await PermissionsAndroid.requestMultiple(permissions);
      
      setPermissionStatus(granted);
      
      const allGranted = Object.values(granted).every(val => val === PermissionsAndroid.RESULTS.GRANTED);
      console.log('Permission results:', granted, 'All granted:', allGranted);
      
      if (!allGranted) {
        console.log('Some permissions were denied:', granted);
        // Show specific permission guidance based on manufacturer
        showPermissionGuidance();
      }
      
      return allGranted;
    } catch (err) {
      console.error('Permission error:', err);
      setStatus('Permission error occurred.');
      return false;
    }
  };

  const showPermissionGuidance = () => {
    const manufacturer = deviceInfo?.manufacturer?.toLowerCase() || '';
    
    let guidance = 'Please grant all permissions in Settings > Apps > Bluetooth Scanner > Permissions';
    
    if (manufacturer.includes('xiaomi') || manufacturer.includes('mi')) {
      guidance = 'Xiaomi: Go to Settings > Apps > Bluetooth Scanner > Permissions. Also enable "Autostart" and disable "Battery Saver" for this app.';
    } else if (manufacturer.includes('huawei')) {
      guidance = 'Huawei: Go to Settings > Apps > Bluetooth Scanner > Permissions. Also enable "Auto-launch" and disable "Battery optimization".';
    } else if (manufacturer.includes('oppo') || manufacturer.includes('oneplus')) {
      guidance = 'OPPO/OnePlus: Go to Settings > Apps > Bluetooth Scanner > Permissions. Also enable "Auto-start" and disable "Battery optimization".';
    } else if (manufacturer.includes('vivo')) {
      guidance = 'Vivo: Go to Settings > Apps > Bluetooth Scanner > Permissions. Also enable "Auto-start" and disable "Battery saver".';
    }
    
    Alert.alert(
      'Permissions Required',
      guidance,
      [
        { text: 'OK', onPress: () => {} },
        { text: 'Open Settings', onPress: () => {
          // Try to open app settings
          const { Linking } = require('react-native');
          Linking.openSettings();
        }}
      ]
    );
  };

  const fetchPairedDevices = async () => {
    try {
      console.log('Fetching paired devices...');
      const granted = await requestPermissions();
      if (!granted) {
        setStatus('Bluetooth permissions are required to fetch paired devices.');
        return;
      }
      
      // First, load saved paired devices from storage
      const savedDevices = await loadPairedDevices();
      
      // Get current bonded devices from system with timeout
      const systemDevices = await Promise.race([
        RNBluetoothClassic.getBondedDevices(),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout getting bonded devices')), 10000)
        )
      ]) as BluetoothDevice[];
      
      // Filter out dummy devices and only keep real ones
      const realPairedDevices = systemDevices.filter((device: BluetoothDevice) => {
        const dummyNames = [
          'Unknown Device', 'Unknown', 'Bluetooth Device', 'BT Device',
          'Device', 'Phone', 'Mobile', 'Android', 'Test Device', 'Dummy Device'
        ];
        
        const isDummyName = dummyNames.some(dummy => 
          device.name && device.name.toLowerCase().includes(dummy.toLowerCase())
        );
        
        const isGenericAddress = device.address && (
          device.address.includes('00:00:00') ||
          device.address.includes('FF:FF:FF') ||
          device.address.includes('AA:AA:AA') ||
          device.address.includes('BB:BB:BB')
        );
        
        return device.bonded && !isDummyName && !isGenericAddress;
      });
      
      setPairedDevices(realPairedDevices);
      await savePairedDevices(realPairedDevices);
      
      console.log('Paired devices loaded:', realPairedDevices.length);
      setStatus(`Found ${realPairedDevices.length} paired devices.`);
      
    } catch (error) {
      console.error('Error fetching paired devices:', error as any);
      setStatus('Error loading paired devices.');
    }
  };

  const scanForDevices = async () => {
    if (!isBluetoothEnabled) {
      setStatus('Bluetooth is disabled. Please enable Bluetooth first.');
      ToastAndroid.show('Please enable Bluetooth', ToastAndroid.LONG);
      return;
    }
    if (!isAppReady) {
      setStatus('App is still initializing. Please wait.');
      return;
    }
    if (isScanning) {
      setStatus('Already scanning. Please wait.');
      return;
    }
    setIsScanning(true);
    setUnpairedDevices([]);
    setStatus('Scanning for devices...');
    try {
      await RNBluetoothClassic.cancelDiscovery();
      await new Promise(res => setTimeout(res, 1000));
      const granted = await requestPermissions();
      if (!granted) {
        setStatus('Bluetooth permissions are required for scanning.');
        setIsScanning(false);
        return;
      }
      const bluetoothStillEnabled = await RNBluetoothClassic.isBluetoothEnabled();
      if (!bluetoothStillEnabled) {
        setStatus('Bluetooth was disabled during scan.');
        setIsScanning(false);
        return;
      }
      setStatus('Scanning...');
      const discoveryPromise = RNBluetoothClassic.startDiscovery();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Scan timeout after 30 seconds')), 30000));
      const discovered = await Promise.race([discoveryPromise, timeoutPromise]);
      if (discovered && Array.isArray(discovered)) {
        const unpairedOnly = discovered.filter(device => {
          const isAlreadyPaired = pairedDevices.some(paired => paired.address === device.address || (paired.name && device.name && paired.name === device.name));
          return !isAlreadyPaired;
        });
        setUnpairedDevices(unpairedOnly);
        setStatus(unpairedOnly.length === 0 ? 'No new devices found.' : `Found ${unpairedOnly.length} new devices.`);
      } else {
        setStatus('Error: Invalid discovery results.');
      }
    } catch (error) {
      let errorMsg = '';
      if (typeof error === 'object' && error !== null && 'message' in error) {
        errorMsg = (error as any).message;
      } else {
        errorMsg = JSON.stringify(error);
      }
      setStatus('Scan error: ' + errorMsg);
    } finally {
      setIsScanning(false);
    }
  };

  const stopScanning = async () => {
    try {
      await RNBluetoothClassic.cancelDiscovery();
      setIsScanning(false);
      setStatus('Scan stopped.');
    } catch (error) {
      console.error('Error stopping scan:', error as any);
    }
  };

  const connectToDevice = async (device: BluetoothDevice) => {
    try {
      console.log('Attempting to connect to device:', device.name || device.address);
      setStatus('Connecting...');
      
      const granted = await requestPermissions();
      if (!granted) {
        setStatus('Bluetooth permissions are required to connect.');
        return;
      }
      
      // If not paired, attempt to pair first
      if (!device.bonded) {
        console.log('Device not paired, attempting to pair first...');
        setStatus(`Pairing with ${device.name || device.address}...`);
        
        try {
          // Use timeout for pairing to prevent hanging
          const pairingPromise = RNBluetoothClassic.pairDevice(device.address);
          const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Pairing timeout')), 15000)
          );
          
          const paired = await Promise.race([pairingPromise, timeoutPromise]);
          console.log('Pairing result:', paired);
          
          if (!paired) {
            setStatus('Pairing failed. Please pair the device manually in Bluetooth settings.');
            return;
          }
          setStatus(`Successfully paired with ${device.name || device.address}. Connecting now...`);
          await fetchPairedDevices();
          await savePairedDevices([...pairedDevices, device]);
        } catch (pairingError) {
          console.error('Pairing error:', pairingError);
          setStatus(`Pairing failed: ${pairingError instanceof Error ? pairingError.message : 'Unknown error'}`);
          return;
        }
      }
      
      // Use timeout for connection to prevent hanging
      console.log('Attempting to connect to device...');
      const connectionPromise = device.connect();
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 20000)
      );
      
      const connected = await Promise.race([connectionPromise, timeoutPromise]);
      console.log('Connection result:', connected);
      
      if (connected) {
        setConnectedDevice(device);
        setStatus(`Connected to ${device.name || device.address}!`);
        await AsyncStorage.setItem('lastConnectedDevice', device.address);
        
        // Set up data listener with error handling
        if (dataSubscription) {
          dataSubscription.remove();
          dataSubscription = null;
        }
        dataSubscription = device.onDataReceived((event: any) => {
          console.log('Received from Bluetooth:', event.data);
          setReceivedData(prev => [...prev, `Received: ${event.data}`]);
          if (appendLogRef.current) {
            appendLogRef.current(event.data);
          }
        });
      } else {
        setStatus(`Failed to connect to ${device.name || device.address}`);
        ToastAndroid.show('Connection failed. Please try again.', ToastAndroid.SHORT);
      }
    } catch (error) {
      console.error('Error connecting to device:', error as any);
      let errorMsg = 'Unknown error';
      
      if (error instanceof Error) {
        errorMsg = error.message;
      } else if (typeof error === 'string') {
        errorMsg = error;
      }
      
      setStatus(`Connection error: ${errorMsg}`);
      ToastAndroid.show('Connection failed. Please try again.', ToastAndroid.SHORT);
    }
  };

  const disconnectDevice = async () => {
    if (!connectedDevice) return;
    try {
      await connectedDevice.disconnect();
      setConnectedDevice(null);
      setReceivedData([]);
      if (dataSubscription) {
        dataSubscription.remove();
        dataSubscription = null;
      }
      setStatus('Disconnected.');
    } catch (error) {
      setStatus('Error disconnecting.');
      console.error('Error disconnecting:', error as any);
    }
  };

  const removePairedDevice = async (device: BluetoothDevice) => {
    try {
      setStatus(`Removing ${device.name || device.address}...`);
      const granted = await requestPermissions();
      if (!granted) {
        setStatus('Bluetooth permissions are required to remove paired devices.');
        return;
      }
      
      // Disconnect if currently connected
      if (connectedDevice && connectedDevice.address === device.address) {
        await disconnectDevice();
      }
      
      // Remove the paired device
      const removed = await RNBluetoothClassic.unpairDevice(device.address);
      if (removed) {
        setStatus(`Successfully removed ${device.name || device.address}. Scanning for available devices...`);
        // Refresh paired devices list
        fetchPairedDevices();
        
        // Remove from storage as well
        const updatedPairedDevices = pairedDevices.filter(d => d.address !== device.address);
        await savePairedDevices(updatedPairedDevices);
        
        // Wait a moment for the unpairing to complete, then scan for available devices
        setTimeout(async () => {
          if (isBluetoothEnabled) {
            try {
              setIsScanning(true);
              setUnpairedDevices([]);
              const discovered = await RNBluetoothClassic.startDiscovery();
              setUnpairedDevices(discovered);
              setStatus(discovered.length === 0 ? 'No available devices found.' : 'Available devices updated.');
            } catch (error) {
              setStatus('Error scanning for available devices after removal.');
              console.error('Error scanning after removal:', error as any);
            } finally {
              setIsScanning(false);
            }
          }
        }, 2000); // Wait 2 seconds before scanning
      } else {
        setStatus(`Failed to remove ${device.name || device.address}`);
      }
    } catch (error) {
      setStatus('Error removing paired device.');
      console.error('Error removing paired device:', error as any);
    }
  };

  const sendMessage = async () => {
    if (!connectedDevice || !message.trim()) return;
    try {
      await connectedDevice.write(message);
      setReceivedData(prev => [...prev, `Sent: ${message}`]);
      setMessage('');
    } catch (error) {
      setStatus('Error sending message.');
      console.error('Error sending message:', error as any);
    }
  };

  const startLogging = async () => {
    if (!connectedDevice) {
      Alert.alert('Not Connected', 'Please connect to a device first before starting logging.');
      return;
    }

    try {
      setStatus('Requesting existing logs from device...');
      
      // First, start the logging context to ensure we can capture data
      logCtx?.startLogging();
      
      // Then request existing logs from the device
      await connectedDevice.write('GET_LOGS\n');
      ToastAndroid.show('Requesting existing logs...', ToastAndroid.SHORT);
      
      // Wait a moment for the device to respond with existing logs
      setTimeout(() => {
        setStatus('Logging started. Capturing new data...');
        ToastAndroid.show('Logging started - capturing new data', ToastAndroid.SHORT);
      }, 3000); // Wait 3 seconds for device to send existing logs
      
    } catch (error) {
      console.error('Error starting logging:', error as any);
      setStatus('Error starting logging. Please try again.');
      Alert.alert('Error', 'Failed to start logging. Please check your connection.');
    }
  };

  const stopLogging = () => {
    logCtx?.stopLogging();
    setStatus('Logging stopped.');
  };

  const exportToExcel = async () => {
    if (!logCtx?.logData || logCtx.logData.length === 0) {
      Alert.alert('No Data', 'No log data to export.');
      return;
    }
    try {
      setStatus('Generating Excel file...');
      console.log('Starting Excel export...');
      // Create workbook and worksheet
      const workbook = XLSX.utils.book_new();
      const excelData = [
        ['Timestamp', 'Data'],
        ...logCtx.logData.map(item => [item.timestamp, item.data])
      ];
      console.log('Excel data:', excelData);
      const worksheet = XLSX.utils.aoa_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Bluetooth Logs');
      const excelBuffer = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
      const fileName = `bluetooth_logs_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.xlsx`;
      if (Platform.OS === 'android') {
        // Debug: Log and alert SafFileModule
        console.log('PLATFORM:', Platform.OS);
        console.log('SafFileModule:', SafFileModule);
        Alert.alert('Debug', 'SafFileModule: ' + JSON.stringify(SafFileModule));
        // Use SAF Save As dialog only
        console.log('Using SAF Save As dialog for Android export');
        try {
          const uri = await SafFileModule.saveFileWithDialog(fileName, excelBuffer);
          setStatus('Excel file saved successfully.');
          Alert.alert('Success', 'File saved to: ' + uri);
        } catch (e) {
          setStatus('Error generating Excel file.');
          Alert.alert('Error', `Failed to save Excel file: ${(e as any)?.message || e}`);
        }
      } else {
        // iOS: Save to DocumentDirectoryPath and share
        const filePath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
        console.log('Writing file to:', filePath);
        await RNFS.writeFile(filePath, excelBuffer, 'base64');
        setStatus('Excel file generated successfully.');
        console.log('Excel file written successfully.');
        await Share.open({
          url: `file://${filePath}`,
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          title: 'Bluetooth Logs',
          filename: fileName,
          showAppsToView: true,
        });
        console.log('Share dialog opened.');
      }
    } catch (error) {
      console.error('Error exporting to Excel:', error);
      setStatus('Error generating Excel file.');
      Alert.alert('Error', `Failed to generate Excel file: ${(error as any)?.message || error}`);
    }
  };

  const testExcelExport = async () => {
    try {
      console.log('Testing Excel export...');
      
      // Create test data
      const testData = [
        { timestamp: new Date().toISOString(), data: 'Test log entry 1' },
        { timestamp: new Date().toISOString(), data: 'Test log entry 2' },
        { timestamp: new Date().toISOString(), data: 'Test log entry 3' }
      ];
      
      // Create workbook and worksheet
      const workbook = XLSX.utils.book_new();
      console.log('Test workbook created');
      
      // Prepare test data for Excel
      const excelData = [
        ['Timestamp', 'Data'], // Header row
        ...testData.map(item => [item.timestamp, item.data])
      ];
      
      // Create worksheet
      const worksheet = XLSX.utils.aoa_to_sheet(excelData);
      console.log('Test worksheet created');
      
      // Add worksheet to workbook
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Test Logs');
      
      // Generate Excel file
      const excelBuffer = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
      console.log('Test Excel buffer generated, size:', excelBuffer.length);
      
      // Create test file path
      const fileName = `test_logs_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.xlsx`;
      const filePath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
      console.log('Test file path:', filePath);
      
      // Write test file
      await RNFS.writeFile(filePath, excelBuffer, 'base64');
      console.log('Test file written successfully');
      
      // Verify test file was created
      const fileExists = await RNFS.exists(filePath);
      console.log('Test file exists after write:', fileExists);
      
      if (fileExists) {
        Alert.alert('Test Success', 'Excel export is working! Test file created successfully.');
      } else {
        Alert.alert('Test Failed', 'File was not created. Check console for details.');
      }
      
    } catch (error) {
      console.error('Test Excel export error:', error);
      Alert.alert('Test Failed', `Error: ${(error as any).message}`);
    }
  };

  const checkCompatibility = () => {
    const issues = [];
    
    if (deviceInfo?.manufacturer?.toLowerCase().includes('xiaomi') || 
        deviceInfo?.manufacturer?.toLowerCase().includes('mi')) {
      issues.push('Xiaomi devices may require location services to be enabled');
      issues.push('Check MIUI battery optimization settings');
      issues.push('Enable "Autostart" for this app in MIUI settings');
    }
    
    if (deviceInfo?.manufacturer?.toLowerCase().includes('huawei')) {
      issues.push('Huawei devices may need additional permissions');
      issues.push('Check EMUI battery optimization settings');
      issues.push('Enable "Auto-launch" for this app in EMUI settings');
    }
    
    if (deviceInfo?.manufacturer?.toLowerCase().includes('oneplus')) {
      issues.push('OnePlus devices may need location services enabled');
      issues.push('Check OxygenOS battery optimization');
      issues.push('Enable "Auto-start" for this app in OxygenOS settings');
    }
    
    if (deviceInfo?.manufacturer?.toLowerCase().includes('oppo')) {
      issues.push('OPPO devices may need location services enabled');
      issues.push('Check ColorOS battery optimization');
      issues.push('Enable "Auto-start" for this app in ColorOS settings');
    }
    
    if (deviceInfo?.manufacturer?.toLowerCase().includes('vivo')) {
      issues.push('Vivo devices may need location services enabled');
      issues.push('Check FuntouchOS battery optimization');
      issues.push('Enable "Auto-start" for this app in FuntouchOS settings');
    }
    
    return issues;
  };

  const getDebugInfo = () => {
    return {
      deviceInfo,
      isBluetoothEnabled,
      isAppReady,
      permissionStatus,
      pairedDevicesCount: pairedDevices.length,
      unpairedDevicesCount: unpairedDevices.length,
      isConnected: !!connectedDevice,
      isScanning,
      status,
    };
  };

  const showDeviceInfo = (device: BluetoothDevice) => {
    Alert.alert(
      device.name || 'Device Info',
      `Name: ${device.name || 'Unknown'}\nAddress: ${device.address}\nBonded: ${device.bonded ? 'Yes' : 'No'}`,
      [{ text: 'OK' }]
    );
  };

  return (
    <>
      <SafeAreaView style={[styles.container, isDarkMode && styles.darkContainer]}>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
        <View style={[styles.customHeader, isDarkMode && styles.customHeaderDark]}>
          <Text style={styles.customHeaderTitle}>Bluetooth Classic</Text>
        </View>
        
        {debugMode && (
          <View style={styles.debugSection}>
            <Text style={[styles.debugTitle, isDarkMode && styles.darkText]}>Debug Info</Text>
            <Text style={[styles.debugText, isDarkMode && styles.darkText]}>
              Device: {deviceInfo?.manufacturer} {deviceInfo?.model}
            </Text>
            <Text style={[styles.debugText, isDarkMode && styles.darkText]}>
              Android: {deviceInfo?.version} (API {deviceInfo?.apiLevel})
            </Text>
            <Text style={[styles.debugText, isDarkMode && styles.darkText]}>
              Bluetooth Enabled: {isBluetoothEnabled ? 'Yes' : 'No'}
            </Text>
            <Text style={[styles.debugText, isDarkMode && styles.darkText]}>
              Paired Devices: {pairedDevices.length}
            </Text>
            <Text style={[styles.debugText, isDarkMode && styles.darkText]}>
              Available Devices: {unpairedDevices.length}
            </Text>
            <Text style={[styles.debugText, isDarkMode && styles.darkText]}>
              Connected: {connectedDevice ? connectedDevice.name || connectedDevice.address : 'None'}
            </Text>
            <Text style={[styles.debugText, isDarkMode && styles.darkText]}>
              Scanning: {isScanning ? 'Yes' : 'No'}
            </Text>
            {checkCompatibility().length > 0 && (
              <View style={styles.compatibilityWarnings}>
                <Text style={[styles.debugTitle, isDarkMode && styles.darkText]}>Compatibility Notes:</Text>
                {checkCompatibility().map((issue, index) => (
                  <Text key={index} style={[styles.warningText, isDarkMode && styles.darkText]}>
                    • {issue}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}
        
        <View style={styles.controls}>
          {!showDeviceLists ? (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', height: '60%', minHeight: 300, marginTop: 60 }}>
              <TouchableOpacity
                style={styles.rectButton}
                onPress={() => setShowDeviceLists(true)}
              >
                <Text style={styles.rectButtonText}>Connect New Device</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.rectButton, { marginTop: 20, borderColor: '#34C759', backgroundColor: 'transparent' }]}
                onPress={() => navigation.navigate('Logs', { connectedDevice })}
              >
                <Text style={[styles.rectButtonText, { color: '#34C759' }]}>Get Logs</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TouchableOpacity
                style={[styles.scanButton, { backgroundColor: '#FF3B30', marginBottom: 10 }]}
                onPress={() => setShowDeviceLists(false)}
              >
                <MaterialIcons name="close" size={20} color="white" style={{ marginRight: 8 }} />
                <Text style={styles.scanButtonText}>Hide Devices</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.scanButton, isScanning && styles.scanningButton]}
                onPress={scanForDevices}
                disabled={isScanning || !isBluetoothEnabled}
              >
                <MaterialIcons name="search" size={20} color="white" style={{ marginRight: 8 }} />
                <Text style={styles.scanButtonText}>{isScanning ? 'Scanning...' : 'Scan for Devices'}</Text>
              </TouchableOpacity>
              {debugMode && (
                <>
                  <TouchableOpacity
                    style={[styles.scanButton, { backgroundColor: '#FF9500', marginTop: 10 }]}
                    onPress={async () => {
                      setStatus('Refreshing app state...');
                      setIsAppReady(false);
                      await initializeApp();
                    }}
                  >
                    <MaterialIcons name="refresh" size={20} color="white" style={{ marginRight: 8 }} />
                    <Text style={styles.scanButtonText}>Refresh App State</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.scanButton, { backgroundColor: '#34C759', marginTop: 10 }]}
                    onPress={async () => {
                      try {
                        setStatus('Testing Bluetooth adapter...');
                        const enabled = await RNBluetoothClassic.isBluetoothEnabled();
                        const bonded = await RNBluetoothClassic.getBondedDevices();
                        setStatus(`Bluetooth: ${enabled ? 'Enabled' : 'Disabled'}, Bonded devices: ${bonded.length}`);
                        console.log('Bluetooth test - Enabled:', enabled, 'Bonded devices:', bonded.length);
                      } catch (error) {
                        setStatus('Bluetooth test failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
                        console.error('Bluetooth test error:', error as any);
                      }
                    }}
                  >
                    <MaterialIcons name="bug-report" size={20} color="white" style={{ marginRight: 8 }} />
                    <Text style={styles.scanButtonText}>Test Bluetooth</Text>
                  </TouchableOpacity>
                </>
              )}
              {debugMode && (
                <TouchableOpacity
                  style={[styles.scanButton, { backgroundColor: '#FF3B30', marginTop: 10 }]}
                  onPress={async () => {
                    try {
                      await RNBluetoothClassic.cancelDiscovery();
                      setStatus('Discovery cancelled.');
                    } catch (e) {
                      setStatus('No discovery to cancel.');
                    }
                  }}
                  disabled={!isScanning}
                >
                  <MaterialIcons name="stop" size={20} color="white" style={{ marginRight: 8 }} />
                  <Text style={styles.scanButtonText}>Stop Scan</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
        {showDeviceLists && (
          <View style={styles.mainContent}>
            <ScrollView style={styles.devicesContainer} showsVerticalScrollIndicator={true}>
              <Text style={[styles.sectionTitle, isDarkMode && styles.darkText]}>Paired devices</Text>
              {pairedDevices.length === 0 ? (
                <Text style={[styles.emptyText, isDarkMode && styles.darkText]}>No paired devices found.</Text>
              ) : (
                pairedDevices.map((item, index) => {
                  const isConnected = connectedDevice && item.address === connectedDevice.address;
                  return (
                    <TouchableOpacity
                      key={item.address}
                      onPress={async () => {
                        if (isConnected) {
                          await disconnectDevice();
                        } else {
                          await connectToDevice(item);
                        }
                      }}
                      style={[
                        styles.deviceRow,
                        isDarkMode && styles.darkDeviceRow,
                        isConnected && styles.connectedDeviceRow
                      ]}
                      activeOpacity={0.8}
                    >
                      <View style={styles.deviceInfoColumn}>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                          <Text
                            style={[
                              styles.deviceNameRow,
                              isDarkMode && styles.darkText,
                              isConnected && styles.connectedDeviceText
                            ]}
                          >
                            {item.name || 'Unknown Device'}
                          </Text>
                          {isConnected && (
                            <MaterialIcons
                              name="bluetooth-connected"
                              size={20}
                              color="limegreen"
                              style={{ marginLeft: 8 }}
                            />
                          )}
                        </View>
                        <Text
                          style={[
                            styles.deviceAddressRow,
                            isDarkMode && styles.darkText,
                            isConnected && styles.connectedDeviceText
                          ]}
                        >
                          {item.address}
                        </Text>
                      </View>
                      <View style={styles.deviceActionsRow}>
                        <TouchableOpacity
                          onPress={() => showDeviceInfo(item)}
                          style={styles.iconButton}
                        >
                          <MaterialIcons name="info" size={22} color="#B3B3B3" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => removePairedDevice(item)}
                          style={styles.iconButton}
                        >
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
                  <Text style={{ color: '#aaa', fontSize: 12, marginTop: 4 }}>
                    Devices will appear here as soon as they are found.
                  </Text>
                </View>
              ) : (
                unpairedDevices.length === 0 ? (
                  <Text style={[styles.emptyText, isDarkMode && styles.darkText]}>No available devices found.</Text>
                ) : (
                  unpairedDevices.map((item, idx) => (
                    <TouchableOpacity
                      key={item.address}
                      style={[styles.deviceRow, isDarkMode && styles.darkDeviceRow]}
                      onPress={() => connectToDevice(item)}
                      disabled={isScanning}
                    >
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
        )}
      </SafeAreaView>
    </>
  );
}

function LogsScreen({ navigation, route }: { navigation: any, route: any }) {
  const isDarkMode = useColorScheme() === 'dark';
  const logCtx = useContext(LogContext);
  const isLogging = logCtx?.isLogging ?? false;
  const logData = logCtx?.logData ?? [];
  const startLogging = logCtx?.startLogging ?? (() => {});
  const stopLogging = logCtx?.stopLogging ?? (() => {});
  const clearLogs = logCtx?.clearLogs ?? (() => {});
  const connectedDevice = route.params?.connectedDevice;

  const exportToExcel = async () => {
    if (!logData || logData.length === 0) {
      Alert.alert('No Data', 'No log data to export.');
      return;
    }
    try {
      console.log('Starting Excel export (LogsScreen)...');
      const workbook = XLSX.utils.book_new();
      const excelData = [
        ['Timestamp', 'Data'],
        ...logData.map(item => [item.timestamp, item.data])
      ];
      console.log('Excel data:', excelData);
      const worksheet = XLSX.utils.aoa_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Bluetooth Logs');
      const excelBuffer = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
      const fileName = `bluetooth_logs_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.xlsx`;
      // Always use DocumentDirectoryPath for all platforms
      const filePath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
      console.log('Writing file to:', filePath);
      await RNFS.writeFile(filePath, excelBuffer, 'base64');
      console.log('Excel file written successfully.');
      await Share.open({
        url: `file://${filePath}`,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        title: 'Bluetooth Logs',
        filename: fileName,
        showAppsToView: true,
      });
      console.log('Share dialog opened.');
      if (Platform.OS === 'android') {
        ToastAndroid.show('Log file exported!', ToastAndroid.LONG);
      } else {
        Alert.alert('Success', 'Log file saved to device.');
      }
    } catch (error) {
      console.error('Error exporting to Excel (LogsScreen):', error);
      Alert.alert('Error', `Failed to generate Excel file: ${(error as any)?.message || error}`);
    }
  };

  return (
    <SafeAreaView style={[styles.container, isDarkMode && styles.darkContainer]}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <View style={[styles.customHeader, isDarkMode && styles.customHeaderDark]}>
        <Text style={styles.customHeaderTitle}>Bluetooth Logs</Text>
      </View>
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.scanButton, isLogging && styles.scanningButton]}
          onPress={async () => {
            if (!connectedDevice) {
              Alert.alert('Not Connected', 'Please connect to a device first before starting logging.');
              return;
            }
            try {
              // Start logging context first
              startLogging();
              // Then request existing logs from the device
              await connectedDevice.write('GET_LOGS\n');
              ToastAndroid.show('Requesting existing logs...', ToastAndroid.SHORT);
              // Optionally, show a status update
            } catch (e) {
              Alert.alert('Error', 'Failed to start logging or request logs.');
            }
          }}
          disabled={isLogging}
        >
          <MaterialIcons name="fiber-manual-record" size={20} color="white" style={{ marginRight: 8 }} />
          <Text style={styles.scanButtonText}>Start Logging (Fetch All Logs)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.scanButton, { backgroundColor: '#FF3B30', marginTop: 10 }]}
          onPress={stopLogging}
          disabled={!isLogging}
        >
          <MaterialIcons name="stop" size={20} color="white" style={{ marginRight: 8 }} />
          <Text style={styles.scanButtonText}>Stop Logging</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.scanButton, { backgroundColor: '#FF3B30', marginTop: 10 }]}
          onPress={async () => {
            if (!connectedDevice) {
              Alert.alert('Not connected', 'Please connect to a device first.');
              return;
            }
            try {
              await connectedDevice.write('CLEAR_LOGS\n');
              ToastAndroid.show('Clear logs command sent', ToastAndroid.SHORT);
            } catch (e) {
              Alert.alert('Error', 'Failed to send clear logs command.');
            }
          }}
        >
          <MaterialIcons name="delete-sweep" size={20} color="white" style={{ marginRight: 8 }} />
          <Text style={styles.scanButtonText}>Clear Device Logs</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.scanButton, { backgroundColor: '#FF9500', marginTop: 10 }]}
          onPress={() => {
            Alert.alert(
              'Clear Logs',
              'Are you sure you want to clear all logged data?',
              [
                { text: 'Cancel', style: 'cancel' },
                { 
                  text: 'Clear', 
                  style: 'destructive',
                  onPress: () => clearLogs()
                }
              ]
            );
          }}
        >
          <MaterialIcons name="clear" size={20} color="white" style={{ marginRight: 8 }} />
          <Text style={styles.scanButtonText}>Clear Logs</Text>
        </TouchableOpacity>
        {connectedDevice && (
          <>
            <TouchableOpacity
              style={[styles.scanButton, { backgroundColor: '#34C759', marginTop: 10 }]}
              onPress={exportToExcel}
              disabled={logData.length === 0}
            >
              <MaterialIcons name="file-download" size={20} color="white" style={{ marginRight: 8 }} />
              <Text style={styles.scanButtonText}>Export to Excel</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
      <View style={styles.terminalContainer}>
        <View style={styles.terminalHeader}>
          <Text style={styles.terminalHeaderText}>
            {isLogging ? '🔴 LIVE LOGGING' : '⏸️ LOGGING PAUSED'} - {logData.length} entries
          </Text>
        </View>
        <ScrollView style={styles.terminalScroll}>
          {logData.map((item, index) => (
            <Text key={index} style={styles.terminalText}>
              {item.data}
            </Text>
          ))}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  darkContainer: {
    backgroundColor: '#1a1a1a',
  },
  customHeader: {
    width: '100%',
    backgroundColor: '#007AFF',
    paddingTop: 40,
    paddingBottom: 16,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  customHeaderDark: {
    backgroundColor: '#0051A8',
  },
  customHeaderTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  controls: {
    paddingHorizontal: 20,
    marginBottom: 20,
    alignItems: 'center',
  },
  scanButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 15,
    borderRadius: 10,
    alignItems: 'center',
    width: '100%',
  },
  scanningButton: {
    backgroundColor: '#666',
  },
  scanButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  devicesContainer: {
    flex: 1,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginTop: 20,
    marginBottom: 10,
  },
  emptyText: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginBottom: 10,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    backgroundColor: '#222',
  },
  darkDeviceRow: {
    backgroundColor: '#222',
    borderBottomColor: '#444',
  },
  deviceInfoColumn: {
    flex: 1,
    flexDirection: 'column',
  },
  deviceNameRow: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '500',
  },
  deviceAddressRow: {
    fontSize: 12,
    color: '#B3B3B3',
  },
  deviceActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 10,
  },
  iconButton: {
    padding: 6,
    marginLeft: 2,
  },
  communicationContainer: {
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#ddd',
    maxHeight: 300,
  },
  messageInput: {
    flexDirection: 'row',
    marginBottom: 15,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    marginRight: 10,
    backgroundColor: 'white',
  },
  darkInput: {
    backgroundColor: '#333',
    borderColor: '#555',
    color: 'white',
  },
  sendButton: {
    backgroundColor: '#34C759',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: 'center',
  },
  dataContainer: {
    flex: 1,
  },
  dataLog: {
    maxHeight: 200,
    backgroundColor: 'white',
    borderRadius: 8,
    padding: 10,
  },
  logEntry: {
    fontSize: 12,
    color: '#333',
    marginBottom: 2,
  },
  darkText: {
    color: '#fff',
  },
  mainContent: {
    flex: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
  },
  refreshButton: {
    padding: 4,
  },
  debugToggle: {
    padding: 4,
  },
  debugSection: {
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  debugTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 10,
  },
  debugText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 5,
  },
  compatibilityWarnings: {
    marginTop: 10,
    padding: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  warningText: {
    fontSize: 12,
    color: '#333',
    marginBottom: 2,
  },
  rectButton: {
    width: 220,
    height: 56,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#00BFFF',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
    marginVertical: 20,
    shadowColor: '#00BFFF',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  rectButtonText: {
    color: '#00BFFF',
    fontSize: 18,
    textAlign: 'center',
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  loggingControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
    flexWrap: 'wrap',
  },
  loggingButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 10,
    paddingHorizontal: 15,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginHorizontal: 5,
  },
  loggingActiveButton: {
    backgroundColor: '#FF3B30',
  },
  loggingButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  logStatus: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    marginTop: 5,
  },
  terminalContainer: {
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 10,
    marginVertical: 10,
    minHeight: 200,
    maxHeight: 300,
    borderWidth: 2,
    borderColor: '#333',
  },
  terminalHeader: {
    backgroundColor: '#222',
    paddingVertical: 8,
    paddingHorizontal: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#444',
  },
  terminalHeaderText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  terminalScroll: {
    flex: 1,
  },
  terminalText: {
    color: '#39FF14', // green terminal text
    fontFamily: 'monospace',
    fontSize: 15,
    marginBottom: 2,
  },
  connectedDeviceRow: {
    backgroundColor: 'rgba(50, 205, 50, 0.12)', // light green background
    borderColor: 'limegreen',
    borderWidth: 2,
    borderRadius: 12,
    shadowColor: 'limegreen',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  connectedDeviceText: {
    color: 'limegreen',
    fontWeight: 'bold',
  },
});

export default function App() {
  return (
    <LogProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Main">
          <Stack.Screen name="Main" component={MainScreen} />
          <Stack.Screen name="Logs" component={LogsScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </LogProvider>
  );
}
