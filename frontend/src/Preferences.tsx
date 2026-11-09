import React, { useEffect, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import FormField from '@cloudscape-design/components/form-field';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';
import { api } from './client';
import { UserPreferences } from './contracts';

interface PreferencesProps {
  token: string;
}

export const Preferences: React.FC<PreferencesProps> = ({ token }) => {
  const [ruleset, setRuleset] = useState<'auto' | 'international' | 'japan'>('auto');
  const [format, setFormat] = useState<'auto' | 'standard' | 'expanded'>('auto');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await api<UserPreferences>('/api/chat/preferences', token);
        if (active && data) {
          setRuleset(data.ruleset || 'auto');
          setFormat(data.format || 'auto');
        }
      } catch (err: any) {
        if (active) {
          setErrorMessage(err.message || 'Failed to load user preferences.');
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [token]);

  const handleSave = async () => {
    setSaving(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await api<UserPreferences>('/api/chat/preferences', token, {
        method: 'PUT',
        body: JSON.stringify({ ruleset, format }),
      });
      setStatusMessage('Preferences saved successfully.');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save preferences.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Configure default ruleset and tournament format for card searches, deck resolution, and budget generation."
        >
          Deck &amp; Ruleset Preferences
        </Header>
      }
    >
      <SpaceBetween size="l">
        {statusMessage && (
          <Alert type="success" dismissible onDismiss={() => setStatusMessage(null)}>
            {statusMessage}
          </Alert>
        )}
        {errorMessage && (
          <Alert type="error" dismissible onDismiss={() => setErrorMessage(null)}>
            {errorMessage}
          </Alert>
        )}

        {loading ? (
          <Box padding="l" textAlign="center">
            <StatusIndicator type="loading">Loading preferences...</StatusIndicator>
          </Box>
        ) : (
          <>
            <FormField
              label="Target Ruleset"
              description="Choose which regional rules, card pools, and banned card lists to apply."
            >
              <RadioGroup
                value={ruleset}
                onChange={({ detail }) => setRuleset(detail.value as any)}
                items={[
                  {
                    value: 'auto',
                    label: 'Auto (Autonomous with Clarification)',
                    description:
                      'The agent resolves cards autonomously when there is no conflict; if a card is banned or exclusive to one region, it prompts you with selectable options.',
                  },
                  {
                    value: 'international',
                    label: 'International (Play! Pokémon)',
                    description:
                      'Enforces International Standard (regulation marks H, I, J) or Expanded (BW through present) and Play! Pokémon banned card list.',
                  },
                  {
                    value: 'japan',
                    label: 'Japan (Official Pokémon Card)',
                    description:
                      'Enforces Japan Standard (regulation marks H, I, J) or Extra (BW through present) and official Pokémon Card Japan regulation ban list.',
                  },
                ]}
              />
            </FormField>

            <FormField
              label="Default Format"
              description="Choose tournament format or let the agent infer it from deck archetype."
            >
              <RadioGroup
                value={format}
                onChange={({ detail }) => setFormat(detail.value as any)}
                items={[
                  {
                    value: 'auto',
                    label: 'Auto (Infer from Deck/Cards)',
                    description:
                      'Automatically chooses Standard if all cards have modern regulation marks, or Expanded if classic cards are included.',
                  },
                  {
                    value: 'standard',
                    label: 'Standard',
                    description: 'Modern tournament rotation (Regulation marks H, I, J).',
                  },
                  {
                    value: 'expanded',
                    label: 'Expanded / Extra',
                    description:
                      'Black & White series to present, respecting active format ban lists.',
                  },
                ]}
              />
            </FormField>

            <Box float="right">
              <Button variant="primary" loading={saving} onClick={handleSave}>
                Save preferences
              </Button>
            </Box>
          </>
        )}
      </SpaceBetween>
    </Container>
  );
};
