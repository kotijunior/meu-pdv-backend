const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuração do nosso Banco de Dados Nuvem
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const JWT_SECRET = process.env.JWT_SECRET || 'chave_mestra_secreta_pdv_2026';

// ==========================================
// MIDDLEWARE DE SEGURANÇA (NOVO)
// ==========================================
const verificarToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(403).json({ error: 'Acesso negado. Crachá (Token) não fornecido.' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Guarda os dados (incluindo store_id) na requisição
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
};

// Rota de teste para ver se o servidor está rodando
app.get('/api/status', (req, res) => {
  res.json({ message: 'PDV Back-end operando com sucesso!' });
});

// Nova rota para testar o Banco de Dados
app.get('/api/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as data_hora_banco');
    client.release();
    res.json({ 
      message: 'Conexão com o Supabase foi um sucesso!', 
      dataHoraNuvem: result.rows[0].data_hora_banco 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao conectar no banco', detalhe: err.message });
  }
});

// Rota de Login com JWT (Atualizada com store_id)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário não encontrado!' });
    }

    const user = result.rows[0];
    
    if (user.password_hash !== password) {
      return res.status(401).json({ error: 'Senha incorreta!' });
    }

    // MÁGICA DO JWT: Agora inclui o store_id da loja a que o utilizador pertence
    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role, store_id: user.store_id },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ 
      message: 'Login realizado com sucesso!', 
      user: { id: user.id, name: user.name, role: user.role },
      token: token
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro no servidor ao tentar logar', detalhe: err.message });
  }
});

// Rota para o Administrador cadastrar um novo operador na mesma loja
app.post('/api/users/operator', verificarToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores podem criar operadores.' });
  }

  const { name, email, password } = req.body;
  try {
    const query = `
      INSERT INTO users (name, email, password_hash, role, store_id)
      VALUES ($1, $2, $3, 'operador', $4)
      RETURNING id, name, email, role;
    `;
    const result = await pool.query(query, [name, email, password, req.user.store_id]);
    res.status(201).json({ message: 'Operador criado com sucesso!', operator: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao cadastrar operador', detalhe: err.message });
  }
});

// Rota para listar os utilizadores/operadores da mesma loja
app.get('/api/users', verificarToken, async (req, res) => {
  try {
    const query = `
      SELECT id, name, email, role, created_at 
      FROM users 
      WHERE store_id = $1 
      ORDER BY created_at DESC;
    `;
    const result = await pool.query(query, [req.user.store_id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar utilizadores', detalhe: err.message });
  }
});

// ==========================================
// ROTAS PROTEGIDAS (Exigem Token e store_id)
// ==========================================

// Rota para cadastrar um novo produto (Multi-loja)
app.post('/api/products', verificarToken, async (req, res) => {
  const { name, barcode, cost_price, sale_price, stock_quantity, category } = req.body;
  try {
    const query = `
      INSERT INTO products (name, barcode, cost_price, sale_price, stock_quantity, category, store_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const values = [name, barcode, cost_price, sale_price, stock_quantity, category, req.user.store_id];
    
    const result = await pool.query(query, values);
    res.status(201).json({ message: 'Produto cadastrado com sucesso!', product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao cadastrar produto', detalhe: err.message });
  }
});

// Rota para listar todos os produtos / Inventário (Multi-loja)
app.get('/api/products', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE store_id = $1 ORDER BY name ASC', [req.user.store_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar o inventário', detalhe: err.message });
  }
});

// Rota para procurar produto pelo código de barras (Multi-loja)
app.get('/api/products/barcode/:barcode', verificarToken, async (req, res) => {
  const { barcode } = req.params;
  try {
    const result = await pool.query('SELECT * FROM products WHERE barcode = $1 AND store_id = $2', [barcode, req.user.store_id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar produto', detalhe: err.message });
  }
});

// Rota para deletar produto (Multi-loja)
app.delete('/api/products/:id', verificarToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1 AND store_id = $2', [req.params.id, req.user.store_id]);
    res.json({ message: 'Produto apagado!' });
  } catch (err) { 
    res.status(500).json({ error: 'Erro ao apagar produto', detalhe: err.message }); 
  }
});

// Rota para atualizar produto (Multi-loja)
app.put('/api/products/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { name, barcode, cost_price, sale_price, stock_quantity, category } = req.body;
  try {
    const query = `
      UPDATE products 
      SET name = $1, barcode = $2, cost_price = $3, sale_price = $4, stock_quantity = $5, category = $6
      WHERE id = $7 AND store_id = $8
      RETURNING *;
    `;
    const result = await pool.query(query, [name, barcode, cost_price, sale_price, stock_quantity, category, id, req.user.store_id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ message: 'Produto atualizado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar produto', detalhe: err.message });
  }
});

// ==========================================
// MÓDULO CRM (GESTÃO DE CLIENTES)
// ==========================================

// Cadastrar um novo cliente (Multi-loja)
app.post('/api/customers', verificarToken, async (req, res) => {
  const { name, email, phone, document } = req.body;
  try {
    const query = `
      INSERT INTO customers (name, email, phone, document, store_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const result = await pool.query(query, [name, email, phone, document, req.user.store_id]);
    res.status(201).json({ message: 'Cliente cadastrado com sucesso!', customer: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao cadastrar cliente', detalhe: err.message });
  }
});

// Listar clientes da loja (Multi-loja)
app.get('/api/customers', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM customers WHERE store_id = $1 ORDER BY name ASC', [req.user.store_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar clientes', detalhe: err.message });
  }
});

// Atualizar um cliente (Multi-loja)
app.put('/api/customers/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, document } = req.body;
  try {
    const query = `
      UPDATE customers 
      SET name = $1, email = $2, phone = $3, document = $4
      WHERE id = $5 AND store_id = $6
      RETURNING *;
    `;
    const result = await pool.query(query, [name, email, phone, document, id, req.user.store_id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ message: 'Cliente atualizado com sucesso!', customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar cliente', detalhe: err.message });
  }
});

// Apagar um cliente (Multi-loja)
app.delete('/api/customers/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM customers WHERE id = $1 AND store_id = $2 RETURNING *', [id, req.user.store_id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ message: 'Cliente apagado com sucesso!' });
  } catch (err) {
    // 23503 é o código de erro do PostgreSQL quando viola uma chave estrangeira (ex: cliente tem vendas)
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Não pode apagar este cliente porque ele já possui histórico de compras no sistema.' });
    }
    res.status(500).json({ error: 'Erro ao apagar cliente', detalhe: err.message });
  }
});

// ==========================================
// MÓDULO DE CONFIGURAÇÕES DA LOJA
// ==========================================

// Buscar configurações
app.get('/api/settings', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT cashback_enabled, cashback_percentage FROM stores WHERE id = $1', [req.user.store_id]);
    res.json(result.rows[0] || { cashback_enabled: false, cashback_percentage: 0 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar configurações', detalhe: err.message });
  }
});

// Atualizar configurações
app.put('/api/settings', verificarToken, async (req, res) => {
  const { cashback_enabled, cashback_percentage } = req.body;
  try {
    await pool.query('UPDATE stores SET cashback_enabled = $1, cashback_percentage = $2 WHERE id = $3', 
      [cashback_enabled, parseFloat(cashback_percentage) || 0, req.user.store_id]);
    res.json({ message: 'Configurações atualizadas com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar configurações', detalhe: err.message });
  }
});

// Rota para registrar uma venda (Multi-loja com CASHBACK)
app.post('/api/sales', verificarToken, async (req, res) => {
  const { items, payment_method, total_amount, customer_id, customer_document, cashback_used } = req.body; 
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Calcula o valor final da venda após o desconto do cashback
    const valorDesconto = cashback_used ? parseFloat(cashback_used) : 0;
    const valorFinal = total_amount - valorDesconto;

    // Insere a venda com o valor final pago
    const saleQuery = `
      INSERT INTO sales (total_amount, payment_method, status, store_id, customer_id, customer_document)
      VALUES ($1, $2, 'completed', $3, $4, $5)
      RETURNING id, created_at;
    `;
    const idDoCliente = customer_id ? customer_id : null;
    const docDoCliente = customer_document ? customer_document : null;
    const saleResult = await client.query(saleQuery, [valorFinal, payment_method, req.user.store_id, idDoCliente, docDoCliente]);
    const saleId = saleResult.rows[0].id;

    // Abate o stock dos itens
    for (const item of items) {
      const itemQuery = `
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal)
        VALUES ($1, $2, $3, $4, $5);
      `;
      const subtotal = item.quantity * item.unit_price;
      await client.query(itemQuery, [saleId, item.product_id, item.quantity, item.unit_price, subtotal]);

      const stockQuery = `
        UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2 AND store_id = $3;
      `;
      await client.query(stockQuery, [item.quantity, item.product_id, req.user.store_id]);
    }

    // LÓGICA DE CASHBACK: Desconta o usado e adiciona o saldo ganho nesta compra
    let cashback_ganho = 0;
    if (idDoCliente) {
      const storeConfig = await client.query('SELECT cashback_enabled, cashback_percentage FROM stores WHERE id = $1', [req.user.store_id]);
      
      // Só gera novo cashback se a loja o tiver ativado nas configurações
      if (storeConfig.rows.length > 0 && storeConfig.rows[0].cashback_enabled) {
        const percentagem = parseFloat(storeConfig.rows[0].cashback_percentage) || 0;
        cashback_ganho = valorFinal * (percentagem / 100);
      }
      
      // Atualiza a carteira do cliente
      await client.query(`
        UPDATE customers 
        SET cashback_balance = COALESCE(cashback_balance, 0) - $1 + $2 
        WHERE id = $3 AND store_id = $4
      `, [valorDesconto, cashback_ganho, idDoCliente, req.user.store_id]);
    }

    await client.query('COMMIT');
    client.release();

    res.status(201).json({ 
      message: 'Venda realizada!', 
      saleId: saleId, 
      cashback_ganho, 
      cashback_usado: valorDesconto,
      total_pago: valorFinal
    });
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar a venda', detalhe: err.message });
  }
});

// Rota para o Histórico de Vendas (Multi-loja com Filtro de Data)
app.get('/api/sales/history', verificarToken, async (req, res) => {
  try {
    const { start, end } = req.query;
    let dateFilter = '';
    const params = [req.user.store_id];

    if (start && end) {
      dateFilter = ' AND s.created_at >= $2 AND s.created_at <= $3';
      params.push(`${start} 00:00:00`, `${end} 23:59:59`);
    }

    const query = `
      SELECT s.id, s.created_at as data, s.total_amount, s.payment_method,
             json_agg(json_build_object('name', p.name, 'quantity', si.quantity, 'subtotal', si.subtotal, 'unit_price', si.unit_price)) as items
      FROM sales s
      JOIN sale_items si ON s.id = si.sale_id
      JOIN products p ON si.product_id = p.id
      WHERE s.store_id = $1${dateFilter}
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT 100
    `;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histórico de vendas', detalhe: err.message });
  }
});

// Rota para puxar o resumo gerencial do dia (Multi-loja com Filtro de Data)
app.get('/api/reports/summary', verificarToken, async (req, res) => {
  try {
    const { start, end } = req.query;
    let dateFilter = '';
    const params = [req.user.store_id];

    if (start && end) {
      dateFilter = ' AND created_at >= $2 AND created_at <= $3';
      params.push(`${start} 00:00:00`, `${end} 23:59:59`);
    }

    const salesResult = await pool.query(`SELECT COUNT(*) as total_vendas, COALESCE(SUM(total_amount), 0) as faturamento_total FROM sales WHERE store_id = $1${dateFilter}`, params);
    const productsResult = await pool.query('SELECT COUNT(*) as total_produtos, COALESCE(SUM(stock_quantity), 0) as itens_estoque FROM products WHERE store_id = $1', [req.user.store_id]);

    res.json({
      totalVendas: salesResult.rows[0].total_vendas,
      faturamentoTotal: parseFloat(salesResult.rows[0].faturamento_total),
      totalProdutosCadastrados: productsResult.rows[0].total_produtos,
      totalItensEstoque: productsResult.rows[0].itens_estoque
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar relatório', detalhe: err.message });
  }
});

// Rota para puxar o resumo gerencial do dia (Multi-loja com Filtro de Data e Alerta de Stock)
app.get('/api/reports/summary', verificarToken, async (req, res) => {
  try {
    const { start, end } = req.query;
    let dateFilter = '';
    const params = [req.user.store_id];

    if (start && end) {
      dateFilter = ' AND created_at >= $2 AND created_at <= $3';
      params.push(`${start} 00:00:00`, `${end} 23:59:59`);
    }

    const salesResult = await pool.query(`SELECT COUNT(*) as total_vendas, COALESCE(SUM(total_amount), 0) as faturamento_total FROM sales WHERE store_id = $1${dateFilter}`, params);
    
    // AQUI É O SEGREDO: Conta produtos e quantos estão com stock <= 5
    const productsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_produtos, 
        COALESCE(SUM(stock_quantity), 0) as itens_estoque,
        COUNT(*) FILTER (WHERE stock_quantity <= 5) as stock_baixo
      FROM products 
      WHERE store_id = $1
    `, [req.user.store_id]);

    // Envia os dados para o Front-end
    res.json({
      totalVendas: salesResult.rows[0].total_vendas,
      faturamentoTotal: parseFloat(salesResult.rows[0].faturamento_total),
      totalProdutosCadastrados: productsResult.rows[0].total_produtos,
      totalItensEstoque: productsResult.rows[0].itens_estoque,
      stock_baixo: parseInt(productsResult.rows[0].stock_baixo) || 0 // Garante que envia um número
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar relatório', detalhe: err.message });
  }
});

// Rota para puxar o histórico e auditoria de caixas (Multi-loja com Filtro de Data)
app.get('/api/reports/cash-history', verificarToken, async (req, res) => {
  try {
    const { start, end } = req.query;
    let dateFilter = '';
    const params = [req.user.store_id];

    if (start && end) {
      dateFilter = ' AND cr.opened_at >= $2 AND cr.opened_at <= $3';
      params.push(`${start} 00:00:00`, `${end} 23:59:59`);
    }

    const query = `
      SELECT 
        cr.id, 
        cr.opened_at, 
        cr.closed_at, 
        cr.opening_balance, 
        cr.closing_balance,
        cr.status,
        COALESCE((
          SELECT SUM(total_amount) 
          FROM sales 
          WHERE store_id = cr.store_id 
          AND payment_method = 'dinheiro' 
          AND created_at >= cr.opened_at 
          AND (cr.closed_at IS NULL OR created_at <= cr.closed_at)
        ), 0) as cash_sales
      FROM cash_registers cr
      WHERE cr.store_id = $1${dateFilter}
      ORDER BY cr.opened_at DESC
      LIMIT 20;
    `;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar relatório de caixas', detalhe: err.message });
  }
});

// Abrir um novo caixa (Multi-loja)
app.post('/api/cash/open', verificarToken, async (req, res) => {
  const { opening_balance } = req.body;
  try {
    const query = `
      INSERT INTO cash_registers (opening_balance, status, store_id)
      VALUES ($1, 'open', $2)
      RETURNING *;
    `;
    const result = await pool.query(query, [opening_balance, req.user.store_id]);
    res.status(201).json({ message: 'Caixa aberto com sucesso!', cashRegister: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao abrir o caixa', detalhe: err.message });
  }
});

// Rota para verificar se existe caixa aberto na loja atual
app.get('/api/cash/status', verificarToken, async (req, res) => {
  try {
    const query = `
      SELECT * FROM cash_registers 
      WHERE store_id = $1 AND status = 'open' 
      ORDER BY opened_at DESC 
      LIMIT 1;
    `;
    const result = await pool.query(query, [req.user.store_id]);
    if (result.rows.length > 0) {
      res.json({ isOpen: true, cashRegister: result.rows[0] });
    } else {
      res.json({ isOpen: false });
    }
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar estado do caixa', detalhe: err.message });
  }
});

// Fechar o caixa
app.post('/api/cash/close/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { closing_balance } = req.body;
  try {
    const query = `
      UPDATE cash_registers 
      SET closing_balance = $1, status = 'closed', closed_at = timezone('utc', now())
      WHERE id = $2 
      RETURNING *;
    `;
    const result = await pool.query(query, [closing_balance, id]);
    res.status(200).json({ message: 'Caixa fechado com sucesso!', cashRegister: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fechar o caixa', detalhe: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});