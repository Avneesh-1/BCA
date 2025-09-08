import React, { createContext, useState } from 'react';

export type LogEntry = { timestamp: string; data: string };

export type LogContextType = {
  isLogging: boolean;
  logData: LogEntry[];
  startLogging: () => void;
  stopLogging: () => void;
  appendLog: (data: string) => void;
  clearLogs: () => void;
};

export const LogContext = createContext<LogContextType | null>(null);

export function LogProvider({ children }: { children: React.ReactNode }) {
  const [isLogging, setIsLogging] = useState(false);
  const [logData, setLogData] = useState<LogEntry[]>([]);

  const startLogging = () => setIsLogging(true);
  const stopLogging = () => setIsLogging(false);
  const appendLog = (data: string) => setLogData(prev => [...prev, { timestamp: new Date().toISOString(), data }]);
  const clearLogs = () => setLogData([]);

  return (
    <LogContext.Provider value={{ isLogging, logData, startLogging, stopLogging, appendLog, clearLogs }}>
      {children}
    </LogContext.Provider>
  );
}


