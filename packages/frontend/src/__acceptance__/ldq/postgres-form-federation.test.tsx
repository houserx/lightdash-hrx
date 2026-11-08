// ldq-postgres-form-federation-switch: the Postgres connection form has a "Federation Engine"
// flavour switch that shows the engine fields and applies the 5433 / operations defaults.
import { DbtProjectType } from '@lightdash/common';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type FC } from 'react';
import ProjectFormContext from '../../components/ProjectConnection/context';
import {
    FormProvider,
    useForm,
    useFormContext,
    type Form,
} from '../../components/ProjectConnection/formContext';
import { PostgresDefaultValues } from '../../components/ProjectConnection/WarehouseForms/defaultValues';
import PostgresForm from '../../components/ProjectConnection/WarehouseForms/PostgresForm';
import { fireEvent, renderUi, screen, setText, waitFor } from './ui';

const FormProbe: FC<{ formRef: { current: Form | null } }> = ({ formRef }) => {
    formRef.current = useFormContext();
    return null;
};

const renderForm = () => {
    const formRef: { current: Form | null } = { current: null };
    const Wrapper: FC = () => {
        const form = useForm({
            initialValues: {
                name: 'Operations',
                dbt: { type: DbtProjectType.NONE },
                warehouse: { ...PostgresDefaultValues },
                dbtVersion: 'v1.8',
            } as never,
        });
        return (
            <ProjectFormContext.Provider value={{}}>
                <FormProvider form={form}>
                    <PostgresForm disabled={false} />
                    <FormProbe formRef={formRef} />
                </FormProvider>
            </ProjectFormContext.Provider>
        );
    };
    renderUi(
        <QueryClientProvider client={new QueryClient()}>
            <Wrapper />
        </QueryClientProvider>,
    );
    return formRef;
};

const warehouse = (formRef: { current: Form | null }) =>
    formRef.current?.values.warehouse as Record<string, unknown>;

describe('PostgresForm Federation Engine flavour', () => {
    it('hides the engine fields for plain Postgres', () => {
        renderForm();
        expect(screen.getByLabelText('Federation Engine')).toBeInTheDocument();
        expect(screen.queryByLabelText(/Identity signing secret/)).toBeNull();
        expect(screen.queryByLabelText(/Engine HTTP URL/)).toBeNull();
    });

    it('switches on the flavour with its defaults and fields', async () => {
        const formRef = renderForm();
        fireEvent.click(screen.getByLabelText('Federation Engine'));
        await waitFor(() => {
            expect(warehouse(formRef).flavor).toBe('federation');
        });
        expect(warehouse(formRef).port).toBe(5433);
        expect(warehouse(formRef).dbname).toBe('operations');
        expect(warehouse(formRef).type).toBe('postgres');

        setText(/Identity signing secret/, 'test-secret-not-real');
        setText(/Engine HTTP URL/, 'http://engine.internal.test:8088');
        await waitFor(() => {
            expect(warehouse(formRef).identitySigningSecret).toBe(
                'test-secret-not-real',
            );
        });
        expect(warehouse(formRef).httpBaseUrl).toBe(
            'http://engine.internal.test:8088',
        );
        expect(
            (screen.getByLabelText(/Identity signing secret/) as HTMLInputElement)
                .type,
        ).toBe('password');
    });

    it('switches back to plain Postgres', async () => {
        const formRef = renderForm();
        const toggle = screen.getByLabelText('Federation Engine');
        fireEvent.click(toggle);
        await waitFor(() => {
            expect(warehouse(formRef).flavor).toBe('federation');
        });
        fireEvent.click(toggle);
        await waitFor(() => {
            expect(warehouse(formRef).flavor ?? 'postgres').toBe('postgres');
        });
        expect(screen.queryByLabelText(/Identity signing secret/)).toBeNull();
    });
});
