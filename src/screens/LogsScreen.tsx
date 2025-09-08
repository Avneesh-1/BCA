import React, { useContext } from 'react';
import { Alert, Platform, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, ToastAndroid, TouchableOpacity, useColorScheme, View } from 'react-native';
import * as XLSX from 'xlsx';
import RNFS from 'react-native-fs';
import Share from 'react-native-share';
import SafFileModule from '../../SafFileModule';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import { LogContext } from '../context/LogContext';

export default function LogsScreen({ route }: { route: any }) {
  const isDarkMode = useColorScheme() === 'dark';
  const logCtx = useContext(LogContext);
  const isLogging = logCtx?.isLogging ?? false;
  const logData = logCtx?.logData ?? [];
  const startLogging = logCtx?.startLogging ?? (() => {});
  const stopLogging = logCtx?.stopLogging ?? (() => {});
  const clearLogs = logCtx?.clearLogs ?? (() => {});
  const connectedDevice = route.params?.connectedDevice;

  const isEpoch = (n: number) => {
    // Accept seconds (10) or millis (13) between years 2000 and 2100
    const sec = n > 2_000_000_000 ? Math.floor(n / 1000) : n;
    return sec >= 946684800 && sec <= 4102444800;
  };

  const formatEpoch = (n: number) => {
    const ms = n > 2_000_000_000 ? n : n * 1000;
    const d = new Date(ms);
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pad = (x: number) => (x < 10 ? `0${x}` : `${x}`);
    return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
  };

  const convertLineTimestamps = (line: string) => {
    return line.replace(/\b\d{10,13}\b/g, (m) => {
      const num = Number(m);
      if (!Number.isFinite(num) || !isEpoch(num)) return m;
      return formatEpoch(num);
    });
  };

  const exportToExcel = async () => {
    if (!logData || logData.length === 0) {
      Alert.alert('No Data', 'No log data to export.');
      return;
    }
    try {
      const workbook = XLSX.utils.book_new();
      
      // Filter only data lines (start with 'D:') and parse them
      const filtered = logData.filter(item => /^\s*D:/i.test(item.data));
      const excelData = [
        ['Serial Number', 'Date', 'Time', 'Outlet PPM', 'Inlet PPM']
      ];
      
      let serialNumber = 1;
      filtered.forEach(item => {
        // Remove 'D:' prefix and parse the data
        const dataLine = item.data.replace(/^\s*D:\s*/, '');
        
        // Parse PPM values and timestamp from the data line
        // Look for patterns like: epoch,outletPPM,inletPPM#P:epoch,otherData;
        const ppmMatch = dataLine.match(/(\d{10,13}),(\d+),(\d+)#/);
        let outletPPM = '';
        let inletPPM = '';
        let dateStr = '';
        let timeStr = '';
        
        if (ppmMatch) {
          const epochTimestamp = parseInt(ppmMatch[1], 10);
          outletPPM = ppmMatch[2];
          inletPPM = ppmMatch[3];
          
          // Convert epoch timestamp to date and time
          const dataDate = new Date(epochTimestamp * 1000); // Convert seconds to milliseconds
          dateStr = dataDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          });
          timeStr = dataDate.toLocaleTimeString('en-US', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
          });
        }
        
        excelData.push([
          (serialNumber++).toString(),
          dateStr,
          timeStr,
          outletPPM,
          inletPPM
        ]);
      });
      
      const worksheet = XLSX.utils.aoa_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Bluetooth Logs');
      const excelBuffer = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
      const fileName = `bluetooth_logs_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.xlsx`;
      if (Platform.OS === 'android') {
        // Use Android SAF Save As dialog to avoid FileProvider/share issues
        const uri = await SafFileModule.saveFileWithDialog(fileName, excelBuffer);
        ToastAndroid.show('Log file saved!', ToastAndroid.LONG);
      } else {
        const filePath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
        await RNFS.writeFile(filePath, excelBuffer, 'base64');
        await Share.open({ url: `file://${filePath}`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', title: 'Bluetooth Logs', filename: fileName, showAppsToView: true });
        Alert.alert('Success', 'Log file saved to device.');
      }
    } catch (error) {
      Alert.alert('Error', `Failed to generate Excel file: ${(error as any)?.message || error}`);
    }
  };

  const styles = getStyles();

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
            if (!connectedDevice) { Alert.alert('Not Connected', 'Please connect to a device first before starting logging.'); return; }
            try { startLogging(); await connectedDevice.write('GET_LOGS\n'); ToastAndroid.show('Requesting existing logs...', ToastAndroid.SHORT); } catch { Alert.alert('Error', 'Failed to start logging or request logs.'); }
          }}
          disabled={isLogging}
        >
          <MaterialIcons name="fiber-manual-record" size={20} color="white" style={{ marginRight: 8 }} />
          <Text style={styles.scanButtonText}>Start Logging (Fetch All Logs)</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.scanButton, { backgroundColor: '#FF3B30', marginTop: 10 }]} onPress={stopLogging} disabled={!isLogging}>
          <MaterialIcons name="stop" size={20} color="white" style={{ marginRight: 8 }} />
          <Text style={styles.scanButtonText}>Stop Logging</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.scanButton, { backgroundColor: '#FF3B30', marginTop: 10 }]}
          onPress={async () => {
            if (!connectedDevice) { Alert.alert('Not connected', 'Please connect to a device first.'); return; }
            try { await connectedDevice.write('CLEAR_LOGS\n'); ToastAndroid.show('Clear logs command sent', ToastAndroid.SHORT); } catch { Alert.alert('Error', 'Failed to send clear logs command.'); }
          }}
        >
          <MaterialIcons name="delete-sweep" size={20} color="white" style={{ marginRight: 8 }} />
          <Text style={styles.scanButtonText}>Clear Device Logs</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.scanButton, { backgroundColor: '#FF9500', marginTop: 10 }]}
          onPress={() => {
            Alert.alert('Clear Logs','Are you sure you want to clear all logged data?',[{ text: 'Cancel', style: 'cancel' },{ text: 'Clear', style: 'destructive', onPress: () => clearLogs() }]);
          }}
        >
          <MaterialIcons name="clear" size={20} color="white" style={{ marginRight: 8 }} />
          <Text style={styles.scanButtonText}>Clear Logs</Text>
        </TouchableOpacity>
        {connectedDevice && (
          <TouchableOpacity style={[styles.scanButton, { backgroundColor: '#34C759', marginTop: 10 }]} onPress={exportToExcel} disabled={logData.length === 0}>
            <MaterialIcons name="file-download" size={20} color="white" style={{ marginRight: 8 }} />
            <Text style={styles.scanButtonText}>Export to Excel</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.terminalContainer}>
        <View style={styles.terminalHeader}>
          <Text style={styles.terminalHeaderText}>{isLogging ? '🔴 LIVE LOGGING' : '⏸️ LOGGING PAUSED'} - {logData.length} entries</Text>
        </View>
        <ScrollView style={styles.terminalScroll}>
          {logData.map((item, index) => (
            <Text key={index} style={styles.terminalText}>{item.data}</Text>
          ))}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function getStyles() {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    darkContainer: { backgroundColor: '#1a1a1a' },
    customHeader: { width: '100%', backgroundColor: '#007AFF', paddingTop: 40, paddingBottom: 16, alignItems: 'center', justifyContent: 'center' },
    customHeaderDark: { backgroundColor: '#0051A8' },
    customHeaderTitle: { color: '#fff', fontSize: 22, fontWeight: 'bold', letterSpacing: 1 },
    controls: { paddingHorizontal: 20, marginBottom: 20, alignItems: 'center' },
    scanButton: { backgroundColor: '#007AFF', paddingVertical: 15, borderRadius: 10, alignItems: 'center', width: '100%' },
    scanningButton: { backgroundColor: '#666' },
    scanButtonText: { color: 'white', fontSize: 16, fontWeight: '600' },
    terminalContainer: { backgroundColor: '#111', borderRadius: 8, padding: 10, marginVertical: 10, minHeight: 200, maxHeight: 300, borderWidth: 2, borderColor: '#333' },
    terminalHeader: { backgroundColor: '#222', paddingVertical: 8, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: '#444' },
    terminalHeaderText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
    terminalScroll: { flex: 1 },
    terminalText: { color: '#39FF14', fontFamily: 'monospace', fontSize: 15, marginBottom: 2 },
  });
}


