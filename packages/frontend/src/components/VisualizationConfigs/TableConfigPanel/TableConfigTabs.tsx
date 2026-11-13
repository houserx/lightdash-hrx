import { memo, type FC } from 'react';
import { VisualizationConfigTabs } from '../common/VisualizationConfigTabs';
import { ColumnCellDisplay } from './ColumnCellDisplay';
import { ColumnValueMappings } from './ColumnValueMappings';
import ConditionalFormattingList from './ConditionalFormattingList';
import GeneralSettings from './GeneralSettings';

export const ConfigTabs: FC = memo(() => (
    <VisualizationConfigTabs
        tabs={[
            { value: 'general', label: 'General', panel: <GeneralSettings /> },
            {
                value: 'conditional-formatting',
                label: 'Conditional formatting',
                panel: <ConditionalFormattingList />,
            },
            {
                value: 'cell-display',
                label: 'Cell display',
                panel: <ColumnCellDisplay />,
            },
            {
                value: 'value-mappings',
                label: 'Value mappings',
                panel: <ColumnValueMappings />,
            },
        ]}
    />
));
