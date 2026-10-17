#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, String, Symbol,
};

/// Errores del token mock
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    /// Ya inicializado
    AlreadyInitialized = 1,
    /// No inicializado
    NotInitialized = 2,
    /// Mint excede el límite permitido
    MintLimitExceeded = 3,
}

/// Estructura para metadatos del token
#[contracttype]
pub struct TokenMetadata {
    pub decimal: u32,
    pub name: String,
    pub symbol: String,
}

/// Almacenamiento de datos del token
#[contracttype]
pub enum DataKey {
    /// Administrador del token
    Admin,
    /// Si el token está inicializado
    Initialized,
    /// Supply total
    TotalSupply,
    /// Metadatos del token
    Metadata,
    /// Balances de usuarios: (Address) -> i128
    Balance(Address),
    /// Allowances: (owner, spender) -> i128
    Allowance(Address, Address),
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    /// Inicializa el token mock con metadatos
    ///
    /// # Arguments
    /// * `env` - Entorno de ejecución
    /// * `admin` - Dirección del administrador (puede hacer mint)
    /// * `decimals` - Número de decimales (ej: 7 para Stellar)
    /// * `name` - Nombre del token
    /// * `symbol` - Símbolo del token
    pub fn initialize(
        env: Env,
        admin: Address,
        decimals: u32,
        name: String,
        symbol: String,
    ) -> Result<(), TokenError> {
        // Verificar que no esté inicializado
        if Self::is_initialized(env.clone()) {
            return Err(TokenError::AlreadyInitialized);
        }

        // Guardar admin
        env.storage().persistent().set(&DataKey::Admin, &admin);

        // Configurar metadatos del token
        let metadata = TokenMetadata {
            decimal: decimals,
            name: name.clone(),
            symbol: symbol.clone(),
        };
        env.storage().persistent().set(&DataKey::Metadata, &metadata);

        // Inicializar supply en 0
        env.storage().persistent().set(&DataKey::TotalSupply, &0i128);

        // Marcar como inicializado
        env.storage().persistent().set(&DataKey::Initialized, &true);

        // Emitir evento de inicialización
        env.events().publish(
            (Symbol::new(&env, "initialized"), admin.clone()),
            (name, symbol, decimals),
        );

        Ok(())
    }

    /// Verifica si el token está inicializado
    pub fn is_initialized(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Initialized)
            .unwrap_or(false)
    }

    /// Acuña (mint) nuevos tokens para una dirección
    /// Solo el admin puede llamar esta función
    ///
    /// # Arguments
    /// * `env` - Entorno de ejecución
    /// * `to` - Dirección que recibirá los tokens
    /// * `amount` - Cantidad a acuñar
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), TokenError> {
        // Verificar que esté inicializado
        if !Self::is_initialized(env.clone()) {
            return Err(TokenError::NotInitialized);
        }

        // Verificar que el admin firme
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        // Verificar que amount sea positivo
        if amount <= 0 {
            return Err(TokenError::MintLimitExceeded);
        }

        // Actualizar balance del destinatario
        let current_balance = Self::balance(env.clone(), to.clone());
        let new_balance = current_balance
            .checked_add(amount)
            .expect("Balance overflow");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_balance);

        // Actualizar total supply
        let current_supply: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = current_supply.checked_add(amount).expect("Supply overflow");

        env.storage()
            .persistent()
            .set(&DataKey::TotalSupply, &new_supply);

        // Emitir evento de mint
        env.events().publish(
            (Symbol::new(&env, "mint"), admin),
            (to.clone(), amount),
        );

        Ok(())
    }

    /// Función pública para que cualquiera pueda mintear tokens (para testing)
    /// ¡Solo usar en Testnet! Esta función no tiene restricciones de admin
    ///
    /// # Arguments
    /// * `env` - Entorno de ejecución
    /// * `to` - Dirección que recibirá los tokens
    /// * `amount` - Cantidad a acuñar
    pub fn mint_public(env: Env, to: Address, amount: i128) -> Result<(), TokenError> {
        // Verificar que esté inicializado
        if !Self::is_initialized(env.clone()) {
            return Err(TokenError::NotInitialized);
        }

        // El destinatario debe autorizar (para evitar mint a terceros sin consentimiento)
        to.require_auth();

        // Verificar que amount sea positivo
        if amount <= 0 {
            return Err(TokenError::MintLimitExceeded);
        }

        // Actualizar balance
        let current_balance = Self::balance(env.clone(), to.clone());
        let new_balance = current_balance
            .checked_add(amount)
            .expect("Balance overflow");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_balance);

        // Actualizar total supply
        let current_supply: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = current_supply.checked_add(amount).expect("Supply overflow");

        env.storage()
            .persistent()
            .set(&DataKey::TotalSupply, &new_supply);

        // Emitir evento de mint
        env.events().publish(
            (Symbol::new(&env, "mint_public"), to.clone()),
            amount,
        );

        Ok(())
    }

    /// Obtiene el balance de una dirección
    pub fn balance(env: Env, address: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(address))
            .unwrap_or(0)
    }

    /// Obtiene el total supply del token
    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    /// Obtiene el administrador del token
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Admin)
    }

    /// Transfiere tokens de una dirección a otra
    /// El `from` debe autorizar la transacción
    ///
    /// # Arguments
    /// * `env` - Entorno de ejecución
    /// * `from` - Dirección origen
    /// * `to` - Dirección destino
    /// * `amount` - Cantidad a transferir
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        // El remitente debe autorizar
        from.require_auth();

        // Verificar balance suficiente
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            panic!("insufficient balance");
        }

        // Actualizar balances
        let new_from_balance = from_balance - amount;
        let to_balance = Self::balance(env.clone(), to.clone());
        let new_to_balance = to_balance
            .checked_add(amount)
            .expect("balance overflow");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &new_from_balance);
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_to_balance);

        // Emitir evento de transfer
        env.events().publish(
            (Symbol::new(&env, "transfer"), from),
            (to, amount),
        );
    }

    /// Aprueba a un gastador para usar tokens del owner
    ///
    /// # Arguments
    /// * `env` - Entorno de ejecución
    /// * `owner` - Propietario de los tokens
    /// * `spender` - Dirección autorizada a gastar
    /// * `amount` - Cantidad aprobada
    pub fn approve(env: Env, owner: Address, spender: Address, amount: i128) {
        owner.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::Allowance(owner.clone(), spender.clone()), &amount);

        // Emitir evento de approve
        env.events().publish(
            (Symbol::new(&env, "approve"), owner),
            (spender, amount),
        );
    }

    /// Obtiene el allowance aprobado
    pub fn allowance(env: Env, owner: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Allowance(owner, spender))
            .unwrap_or(0)
    }

    /// Transfiere desde una dirección con allowance
    ///
    /// # Arguments
    /// * `env` - Entorno de ejecución
    /// * `spender` - Quien ejecuta la transferencia
    /// * `from` - Propietario de los tokens
    /// * `to` - Destino
    /// * `amount` - Cantidad
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        // Verificar allowance
        let current_allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        if current_allowance < amount {
            panic!("insufficient allowance");
        }

        // El spender debe autorizar
        spender.require_auth();

        // Reducir allowance
        let new_allowance = current_allowance - amount;
        env.storage()
            .persistent()
            .set(&DataKey::Allowance(from.clone(), spender.clone()), &new_allowance);

        // Ejecutar transferencia
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            panic!("insufficient balance");
        }

        let new_from_balance = from_balance - amount;
        let to_balance = Self::balance(env.clone(), to.clone());
        let new_to_balance = to_balance
            .checked_add(amount)
            .expect("balance overflow");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &new_from_balance);
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_to_balance);

        // Emitir evento
        env.events().publish(
            (Symbol::new(&env, "transfer"), from),
            (to, amount),
        );
    }

    /// Obtiene los metadatos del token
    pub fn get_metadata(env: Env) -> Option<TokenMetadata> {
        env.storage().persistent().get(&DataKey::Metadata)
    }

    /// Obtiene los decimales del token
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Metadata)
            .map(|m: TokenMetadata| m.decimal)
            .unwrap_or(7)
    }

    /// Obtiene el nombre del token
    pub fn name(env: Env) -> String {
        env.storage()
            .persistent()
            .get(&DataKey::Metadata)
            .map(|m: TokenMetadata| m.name)
            .unwrap_or_else(|| String::from_str(&env, "MOCK"))
    }

    /// Obtiene el símbolo del token
    pub fn symbol(env: Env) -> String {
        env.storage()
            .persistent()
            .get(&DataKey::Metadata)
            .map(|m: TokenMetadata| m.symbol)
            .unwrap_or_else(|| String::from_str(&env, "MOCK"))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let client = MockTokenClient::new(&env, &env.register(MockToken, ()));

        let name = String::from_str(&env, "Mock Token");
        let symbol = String::from_str(&env, "MOCK");

        client.initialize(&admin, &7, &name, &symbol);
        assert!(client.is_initialized());
    }
}
