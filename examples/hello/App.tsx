// The smallest app that shows `hangar run ios` working: edit the text, save, and the leased
// simulator updates through Fast Refresh while the count stays.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hello from Hangar</Text>
      <Pressable accessibilityRole="button" style={styles.button} onPress={() => setCount((c) => c + 1)}>
        <Text style={styles.label}>Tapped {count} times</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '600' },
  button: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: '#1a73e8' },
  label: { color: '#fff', fontSize: 18 },
});
